import { Field, UInt64, Poseidon, MerkleMap, PublicKey } from 'o1js';
import { CDPPosition } from '../contracts/ZKUSDOrchestrator.js';
import { createClient } from 'redis';

export class CDPStateManager {
  private redisClient: ReturnType<typeof createClient>;
  private cdpMap: MerkleMap;
  private cdpOwnershipMap: MerkleMap;
  private orchestratorPublicKey: PublicKey;

  constructor(orchestratorPublicKey: PublicKey) {
    this.redisClient = createClient();
    this.orchestratorPublicKey = orchestratorPublicKey;
    this.cdpMap = new MerkleMap();
    this.cdpOwnershipMap = new MerkleMap();
  }

  async initialize() {
    await this.redisClient.connect();
    await this.loadState();
  }

  async loadState() {
    const orchestratorKey = this.orchestratorPublicKey.toBase58();
    const cdpMapState = await this.redisClient.get(
      `cdpMapState:${orchestratorKey}`
    );
    const cdpOwnershipMapState = await this.redisClient.get(
      `cdpOwnershipMapState:${orchestratorKey}`
    );

    if (cdpMapState) {
      const state = JSON.parse(cdpMapState);
      this.cdpMap = new MerkleMap();
      for (const [key, value] of Object.entries(state)) {
        this.cdpMap.set(Field(key), Field(value as string));
      }
    }

    if (cdpOwnershipMapState) {
      const state = JSON.parse(cdpOwnershipMapState);
      this.cdpOwnershipMap = new MerkleMap();
      for (const [key, value] of Object.entries(state)) {
        this.cdpOwnershipMap.set(Field(key), Field(value as string));
      }
    }
  }

  async getCDPPosition(cdpId: Field): Promise<CDPPosition> {
    const orchestratorKey = this.orchestratorPublicKey.toBase58();
    const key = cdpId.toString();
    const cdpData = await this.redisClient.get(`cdp:${orchestratorKey}:${key}`);
    if (!cdpData) {
      const newCDP = new CDPPosition({
        id: cdpId,
        collateralAmount: UInt64.from(0),
        debtAmount: UInt64.from(0),
      });
      await this.redisClient.set(
        `cdp:${orchestratorKey}:${key}`,
        JSON.stringify(newCDP)
      );
      return newCDP;
    }
    return CDPPosition.fromJSON(JSON.parse(cdpData));
  }

  async updateCDPPosition(
    cdpId: Field,
    updates: Partial<CDPPosition>,
    secret?: Field
  ) {
    const orchestratorKey = this.orchestratorPublicKey.toBase58();
    const key = cdpId.toString();
    const currentPosition = await this.getCDPPosition(cdpId);

    const updatedPosition = new CDPPosition({
      id: currentPosition.id,
      collateralAmount:
        updates.collateralAmount ?? currentPosition.collateralAmount,
      debtAmount: updates.debtAmount ?? currentPosition.debtAmount,
    });

    await this.redisClient.set(
      `cdp:${orchestratorKey}:${key}`,
      JSON.stringify(updatedPosition)
    );

    // Update the cdpMap
    const cdpCommitment = Poseidon.hash(CDPPosition.toFields(updatedPosition));
    this.cdpMap.set(cdpId, cdpCommitment);

    // Update cdpMapState in Redis
    const cdpMapState = JSON.parse(
      (await this.redisClient.get(`cdpMapState:${orchestratorKey}`)) || '{}'
    );
    cdpMapState[key] = cdpCommitment.toString();
    await this.redisClient.set(
      `cdpMapState:${orchestratorKey}`,
      JSON.stringify(cdpMapState)
    );

    // If secret is provided, update the cdpOwnershipMap
    if (secret !== undefined) {
      const ownershipCommitment = Poseidon.hash([cdpId, secret]);
      this.cdpOwnershipMap.set(cdpId, ownershipCommitment);

      // Update cdpOwnershipMapState in Redis
      const cdpOwnershipMapState = JSON.parse(
        (await this.redisClient.get(
          `cdpOwnershipMapState:${orchestratorKey}`
        )) || '{}'
      );
      cdpOwnershipMapState[key] = ownershipCommitment.toString();
      await this.redisClient.set(
        `cdpOwnershipMapState:${orchestratorKey}`,
        JSON.stringify(cdpOwnershipMapState)
      );
    }
  }

  getCDPWitness(cdpId: Field) {
    return this.cdpMap.getWitness(cdpId);
  }

  getCDPOwnershipWitness(cdpId: Field) {
    return this.cdpOwnershipMap.getWitness(cdpId);
  }

  getCDPRoot(): Field {
    return this.cdpMap.getRoot();
  }

  getCDPOwnershipRoot(): Field {
    return this.cdpOwnershipMap.getRoot();
  }

  async close() {
    await this.redisClient.quit();
  }
}
