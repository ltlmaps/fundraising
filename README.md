# Aragon Fundraising App

## Architecture

![](assets/img/architecture.svg "Architecture")

## Contracts

### BondingCurve

##### Interface

```solidity
function buy(uint256 _value) external payable;
function sell(uint256 _amount) external;
```

##### Roles

|              | Description                                | Grantee       |
| ------------ |:-------------------------------------------| -------------:|
| `BUY_ROLE`   | Buy bonds against ETH or ERC-20 collateral | `ANY_ADDRESS` |
| `SELL_ROLE`  | Redeem bonds for ETH or ERC-20 collateral  | `ANY_ADDRESS` |

### CollateralPool

##### Interface

```solidity
function deposit(address _token, uint256 _value) external payable;
function transfer(address _token, uint256 _value) external;
```

##### Roles

|                  | Description                                          | Grantee                     |
| ---------------- |:-----------------------------------------------------| ---------------------------:|
| `DEPOSIT_ROLE`   | Deposit ETH or ERC-20 into the `CollateralPool`      | `BondingCurve` contract[s]  |
| `TRANSFER_ROLE`  | Transfer ETH or ERC-20 to the discretionary `Vault`  | `Tap` contract              |


##### Notes

Depending on the token address the contract must also hook into the `BondingCurve` contract to let it [optionnally] update its `vBalance` state variable [thus reflecting the requested changes in the price curve]

##### Questions

It's better to limit transfers's to a vault address defined on initialization, right?


### Tap


##### Interface

```solidity
function updateTap(uint256 _tap) external;
function withdraw() external;
```

##### Roles

|                   | Description                                                                   | Grantee                  |
| ----------------- |:------------------------------------------------------------------------------| ------------------------:|
| `UPDATE_TAP_ROLE` | Update tap rate                                                               | `Voting [BOND]` contract |
| `WITHDRAW_ROLE`   | Withdraw ETH or ERC-20 from the `CollateralPool` to the discretionary `Vault` | `ANY_ADDRESS`            |

##### Notes

Implementing the tap system as an external contract owning TRANSFER_ROLE over the `CollateralPool` contract provides more modularity than implementing it directly into the `CollateralPool` contract.
