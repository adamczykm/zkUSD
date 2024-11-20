# zkUSD Protocol

zkUSD is a private, algorithmic stablecoin protocol built on the Mina Protocol. It enables users to mint zkUSD tokens by depositing MINA as collateral through individual vaults.

## Overview

zkUSD implements a novel architecture where each user deploys their own personal vault zkApp to manage their Collateralized Debt Positions (CDPs). This approach provides:

- **Decentralized State Management**: Each vault operates independently, eliminating concurrency issues
- **Atomic Operations**: All state transitions are confined within individual vaults
- **Interoperability**: zkUSD is available on L1 mina
- **Enhanced Security**: Users maintain full control over their vaults

## Key Components

### Protocol Vault

The central administrative zkApp manages:

- Oracle whitelisting
- Protocol fees (these fees are a % of the staking rewards earnt from locked MINA in vaults)
- Emergency controls
- Administrative functions

### Price Feed Oracle

A decentralized price oracle system that:

- Aggregates price submissions from whitelisted oracles
- Calculates median prices
- Handles price updates across even/odd blocks lagging pattern to ensure constient price updates while accounting for Mina's concurrency limitations
- Provides emergency halt functionality

### Individual User Vaults

Key features:

- Lock MINA collateral
- Mint zkUSD tokens
- Manage collateralization through redemption and burning of debt (zkUSD)
- Vaults allow liquidation by anyone if they become undercollateralised, ensuring platform stability
- Any deposited MINA is delegated and the vault earns those rewards effectively providing negative interest rates on loans.

## Installation

### Clone

```sh
git clone https://github.com/Charlie-Mack/zkUSD.git

cd zkUSD
```

### Install Dependencies

```sh
npm install
```

### Test

```sh
npm test
```
