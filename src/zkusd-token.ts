import {
  AccountUpdate,
  AccountUpdateForest,
  assert,
  Bool,
  DeployArgs,
  Field,
  Int64,
  method,
  Permissions,
  Provable,
  PublicKey,
  State,
  state,
  Struct,
  TokenContractV2,
  Types,
  UInt64,
  UInt8,
  VerificationKey,
} from 'o1js';
import { ZkUsdVault } from './zkusd-vault';

/**
 * @title   zkUSD Token Contract
 * @notice  Unfortunately we cant use the Mina Fungible Token standard as it is too expensive in terms of
 *          account updates. Therefore we use a slightly altered version of the standard that performs
 *          the administrative functions of the token within the contract itself, reducing the account updates
 *          required.
 */

// Errors
export const ZkUsdTokenErrors = {
  NO_PERMISSION_TO_MINT: 'Not allowed to mint tokens',
  NO_XFER_FROM_CIRC: "Can't transfer to/from the circulation account",
  UNAUTHORIZED_PERM_CHANGE:
    "Can't change permissions for access or receive on token accounts",
  FLASH_MINTING:
    'Flash-minting or unbalanced transaction detected. Please make sure that your transaction is balanced, and that your `AccountUpdate`s are ordered properly, so that tokens are not received before they are sent.',
  UNBALANCED: 'Transaction is unbalanced',
};

// Events
export class MintEvent extends Struct({
  recipient: PublicKey,
  amount: UInt64,
}) {}

export class BurnEvent extends Struct({
  from: PublicKey,
  amount: UInt64,
}) {}

export class BalanceChangeEvent extends Struct({
  address: PublicKey,
  amount: Int64,
}) {}

/**
 * @notice  Props required for deploying the token contract
 * @param   symbol The token symbol
 * @param   src A source code reference (typically GitHub link) for the zkappUri
 */
interface FungibleTokenDeployProps extends Exclude<DeployArgs, undefined> {
  symbol: string;
  src: string;
}

export class ZkUsdToken extends TokenContractV2 {
  @state(UInt8)
  decimals = State<UInt8>();

  readonly events = {
    Mint: MintEvent,
    Burn: BurnEvent,
    BalanceChange: BalanceChangeEvent,
  };

  static ZkUsdVaultContract: new (...args: any) => ZkUsdVault = ZkUsdVault;

  /**
   * @notice  Deploys the token contract and sets initial permissions
   * @param   props Deployment properties including symbol and source reference
   */
  async deploy(props: FungibleTokenDeployProps) {
    await super.deploy(props);
    this.account.zkappUri.set(props.src);
    this.account.tokenSymbol.set(props.symbol);

    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      access: Permissions.proof(),
    });
  }

  /**
   * @notice  Updates the verification key for the contract
   * @param   vk The new verification key
   */
  @method
  async updateVerificationKey(vk: VerificationKey) {
    this.account.verificationKey.set(vk);
  }

  /**
   * @notice  Initializes the token contract with decimal precision
   * @param   decimals The number of decimal places for the token
   */
  @method
  async initialize(decimals: UInt8) {
    this.account.provedState.requireEquals(Bool(false));

    this.decimals.set(decimals);

    const accountUpdate = AccountUpdate.createSigned(
      this.address,
      this.deriveTokenId()
    );
    let permissions = Permissions.default();
    // This is necessary in order to allow token holders to burn.
    permissions.send = Permissions.none();
    permissions.setPermissions = Permissions.impossible();
    accountUpdate.account.permissions.set(permissions);
  }

  /**
   * @notice  Mints new tokens to a recipient
   * @dev     IMPORTANT: Only vaults with valid proofs can mint tokens
   * @param   recipient The address receiving the minted tokens
   * @param   amount The amount of tokens to mint
   * @param   _accountUpdate The vault's account update for verification
   * @returns The account update for the mint operation
   */
  @method.returns(AccountUpdate)
  async mint(
    recipient: PublicKey,
    amount: UInt64,
    _accountUpdate: AccountUpdate
  ): Promise<AccountUpdate> {
    const zkUSDVault = new ZkUsdToken.ZkUsdVaultContract(
      _accountUpdate.publicKey
    );
    // Check that the vault has the interaction flag set, we should only ever allow minting from a vault that has generated a valid proof
    const canMint = await zkUSDVault.assertInteractionFlag();
    canMint.assertTrue(ZkUsdTokenErrors.NO_PERMISSION_TO_MINT);
    const accountUpdate = this.internal.mint({ address: recipient, amount });
    recipient
      .equals(this.address)
      .assertFalse(ZkUsdTokenErrors.NO_XFER_FROM_CIRC);
    this.approve(accountUpdate);
    this.emitEvent('Mint', new MintEvent({ recipient, amount }));
    const circulationUpdate = AccountUpdate.create(
      this.address,
      this.deriveTokenId()
    );
    circulationUpdate.balanceChange = Int64.fromUnsigned(amount);
    return accountUpdate;
  }

  /**
   * @notice  Burns tokens from a specified address
   * @param   from The address to burn tokens from
   * @param   amount The amount of tokens to burn
   * @returns The account update for the burn operation
   */
  @method.returns(AccountUpdate)
  async burn(from: PublicKey, amount: UInt64): Promise<AccountUpdate> {
    const accountUpdate = this.internal.burn({ address: from, amount });
    const circulationUpdate = AccountUpdate.create(
      this.address,
      this.deriveTokenId()
    );
    from.equals(this.address).assertFalse(ZkUsdTokenErrors.NO_XFER_FROM_CIRC);
    circulationUpdate.balanceChange = Int64.fromUnsigned(amount).negV2();
    this.emitEvent('Burn', new BurnEvent({ from, amount }));
    return accountUpdate;
  }

  /**
   * @notice  Transfers tokens between addresses
   * @param   from The sender's address
   * @param   to The recipient's address
   * @param   amount The amount of tokens to transfer
   */
  @method
  async transfer(from: PublicKey, to: PublicKey, amount: UInt64) {
    from.equals(this.address).assertFalse(ZkUsdTokenErrors.NO_XFER_FROM_CIRC);
    to.equals(this.address).assertFalse(ZkUsdTokenErrors.NO_XFER_FROM_CIRC);
    this.internal.send({ from, to, amount });
  }

  /**
   * @notice  Internal helper to validate permission updates
   * @dev     Ensures that access and receive permissions are not modified
   * @param   update The account update to check
   */
  private checkPermissionsUpdate(update: AccountUpdate) {
    let permissions = update.update.permissions;

    let { access, receive } = permissions.value;
    let accessIsNone = Provable.equal(
      Types.AuthRequired,
      access,
      Permissions.none()
    );
    let receiveIsNone = Provable.equal(
      Types.AuthRequired,
      receive,
      Permissions.none()
    );
    let updateAllowed = accessIsNone.and(receiveIsNone);

    assert(
      updateAllowed.or(permissions.isSome.not()),
      ZkUsdTokenErrors.UNAUTHORIZED_PERM_CHANGE
    );
  }

  /**
   * @notice  Approves external account updates for token operations
   * @dev     Validates permissions and ensures balanced token operations
   * @param   updates The forest of account updates to approve
   */
  @method
  async approveBase(updates: AccountUpdateForest): Promise<void> {
    let totalBalance = Int64.from(0);
    this.forEachUpdate(updates, (update, usesToken) => {
      // Make sure that the account permissions are not changed
      this.checkPermissionsUpdate(update);
      this.emitEventIf(
        usesToken,
        'BalanceChange',
        new BalanceChangeEvent({
          address: update.publicKey,
          amount: update.balanceChange,
        })
      );
      // Don't allow transfers to/from the account that's tracking circulation
      update.publicKey
        .equals(this.address)
        .and(usesToken)
        .assertFalse(ZkUsdTokenErrors.NO_XFER_FROM_CIRC);
      totalBalance = Provable.if(
        usesToken,
        totalBalance.add(update.balanceChange),
        totalBalance
      );
      totalBalance.isPositiveV2().assertFalse(ZkUsdTokenErrors.FLASH_MINTING);
    });
    totalBalance.assertEquals(Int64.zero, ZkUsdTokenErrors.UNBALANCED);
  }

  /**
   * @notice  Gets the token balance of an address
   * @param   address The address to check
   * @returns The token balance
   */
  @method.returns(UInt64)
  async getBalanceOf(address: PublicKey): Promise<UInt64> {
    const account = AccountUpdate.create(address, this.deriveTokenId()).account;
    const balance = account.balance.get();
    account.balance.requireEquals(balance);
    return balance;
  }

  /**
   * @notice  Gets the current total circulating supply
   * @dev     Doesnt take into account any unreduced actions
   * @returns The total circulating supply
   */
  async getCirculating(): Promise<UInt64> {
    let circulating = await this.getBalanceOf(this.address);
    return circulating;
  }

  /**
   * @notice  Gets the token's decimal precision
   * @returns The number of decimal places
   */
  @method.returns(UInt8)
  async getDecimals(): Promise<UInt8> {
    return this.decimals.getAndRequireEquals();
  }
}
