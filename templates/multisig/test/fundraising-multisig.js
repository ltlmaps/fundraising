const encodeCall = require('@aragon/templates-shared/helpers/encodeCall')
const assertRevert = require('@aragon/templates-shared/helpers/assertRevert')(web3)

const { hash: namehash } = require('eth-ens-namehash')
// const { APP_IDS } = require('@aragon/templates-shared/helpers/apps')
const { randomId } = require('@aragon/templates-shared/helpers/aragonId')
const { getEventArgument } = require('@aragon/test-helpers/events')
const { deployedAddresses } = require('@aragon/templates-shared/lib/arapp-file')(web3)
// const { getInstalledAppsById } = require('@aragon/templates-shared/helpers/events')(artifacts)
const { assertRole, assertMissingRole } = require('@aragon/templates-shared/helpers/assertRole')(web3)

const abi = require('web3-eth-abi') // to move in helpers

const CompanyTemplate = artifacts.require('FundraisingMultisigTemplate')

const ENS = artifacts.require('ENS')
const ACL = artifacts.require('ACL')
const Kernel = artifacts.require('Kernel')
const Agent = artifacts.require('Agent')
const Vault = artifacts.require('Vault')
const Voting = artifacts.require('Voting')
const Finance = artifacts.require('Finance')
const TokenManager = artifacts.require('TokenManager')
const Pool = artifacts.require('Pool')
const MarketMaker = artifacts.require('BatchedBancorMarketMaker')
const Tap = artifacts.require('Tap')
const Controller = artifacts.require('AragonFundraisingController')

const MiniMeToken = artifacts.require('MiniMeToken')
const PublicResolver = artifacts.require('PublicResolver')
const EVMScriptRegistry = artifacts.require('EVMScriptRegistry')
const TokenMock = artifacts.require('TokenMock')

const APPS = [
  { name: 'agent', contractName: 'Agent' },
  { name: 'vault', contractName: 'Vault' },
  { name: 'voting', contractName: 'Voting' },
  { name: 'finance', contractName: 'Finance' },
  { name: 'token-manager', contractName: 'TokenManager' },
  { name: 'pool', contractName: 'Pool' },
  { name: 'bancor-formula', contractName: 'BancorFormula' },
  { name: 'batched-bancor-market-maker', contractName: 'BatchedBancorMarketMaker' },
  { name: 'tap', contractName: 'Tap' },
  { name: 'aragon-fundraising', contractName: 'AragonFundraisingController' },
]

const APP_IDS = APPS.reduce((ids, { name }) => {
  ids[name] = namehash(`${name}.aragonpm.eth`)
  return ids
}, {})

const decodeEvents = ({ receipt }, contractAbi, eventName) => {
  const eventAbi = contractAbi.filter(abi => abi.name === eventName && abi.type === 'event')[0]
  const eventSignature = abi.encodeEventSignature(eventAbi)
  const eventLogs = receipt.logs.filter(l => l.topics[0] === eventSignature)
  return eventLogs.map(log => {
    log.event = eventAbi.name
    log.args = abi.decodeLog(eventAbi.inputs, log.data, log.topics.slice(1))
    return log
  })
}

const getInstalledApps = (receipt, appId) => {
  const Kernel = artifacts.require('Kernel')
  const events = decodeEvents(receipt, Kernel.abi, 'NewAppProxy')
  const appEvents = events.filter(e => e.args.appId === appId)
  const installedAddresses = appEvents.map(e => e.args.proxy)
  return installedAddresses
}

const getInstalledAppsById = receipt => {
  return Object.keys(APP_IDS).reduce((apps, appName) => {
    apps[appName] = getInstalledApps(receipt, APP_IDS[appName])
    return apps
  }, {})
}

const ANY_ADDRESS = { address: '0xffffffffffffffffffffffffffffffffffffffff' }
const ONE_DAY = 60 * 60 * 24
const ONE_WEEK = ONE_DAY * 7
const THIRTY_DAYS = ONE_DAY * 30
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('Fundraising with multisig', ([_, owner, boardMember1, boardMember2, shareHolder1, shareHolder2, shareHolder3, someone]) => {
  let daoID, template, dao, acl, ens, feed
  let shareVoting, boardVoting, boardTokenManager, shareTokenManager, boardToken, shareToken, finance, agent, vault, reserve, marketMaker, tap, controller
  let COLLATERAL_1, COLLATERAL_2, COLLATERALS

  const BOARD_MEMBERS = [boardMember1, boardMember2]
  const SHARE_HOLDERS = [shareHolder1, shareHolder2, shareHolder3]

  const BOARD_TOKEN_NAME = 'Board Token'
  const BOARD_TOKEN_SYMBOL = 'BOARD'

  // const SHARE_STAKES = SHARE_HOLDERS.map(() => 1e18)
  const SHARE_TOKEN_NAME = 'Share Token'
  const SHARE_TOKEN_SYMBOL = 'SHARE'

  const BOARD_VOTE_DURATION = ONE_WEEK
  const BOARD_SUPPORT_REQUIRED = 50e16
  const BOARD_MIN_ACCEPTANCE_QUORUM = 40e16
  const BOARD_VOTING_SETTINGS = [BOARD_SUPPORT_REQUIRED, BOARD_MIN_ACCEPTANCE_QUORUM, BOARD_VOTE_DURATION]

  const SHARE_VOTE_DURATION = ONE_WEEK
  const SHARE_SUPPORT_REQUIRED = 50e16
  const SHARE_MIN_ACCEPTANCE_QUORUM = 5e16
  const SHARE_VOTING_SETTINGS = [SHARE_SUPPORT_REQUIRED, SHARE_MIN_ACCEPTANCE_QUORUM, SHARE_VOTE_DURATION]

  const VIRTUAL_SUPPLIES = [Math.pow(10, 19), Math.pow(10, 18)]
  const VIRTUAL_BALANCES = [2 * Math.pow(10, 19), 2 * Math.pow(10, 18)]
  const RESERVE_RATIOS = [100000, 10000]
  const TAPS = [20000, 5000]
  const FLOORS = [150, 750]
  const SLIPPAGES = [3 * Math.pow(10, 19), Math.pow(10, 18)]

  before('fetch company board template and ENS', async () => {
    const { registry, address } = await deployedAddresses()
    ens = ENS.at(registry)
    template = CompanyTemplate.at(address)
  })

  before('deploy collateral tokens', async () => {
    COLLATERAL_1 = await TokenMock.new('0xb4124cEB3451635DAcedd11767f004d8a28c6eE7', 1000000000000000000)
    COLLATERAL_2 = await TokenMock.new('0xb4124cEB3451635DAcedd11767f004d8a28c6eE7', 1000000000000000000)
    COLLATERALS = [COLLATERAL_1.address, COLLATERAL_2.address]
  })

  context('when the creation fails', () => {
    const FINANCE_PERIOD = 0
    const USE_AGENT_AS_VAULT = true

    // context('when there was no instance prepared before', () => {
    //   it('reverts when there was no instance prepared before', async () => {
    //     await assertRevert(
    //       finalizeInstance(randomId(), SHARE_HOLDERS, SHARE_STAKES, BOARD_MEMBERS, FINANCE_PERIOD, USE_AGENT_AS_VAULT),
    //       'COMPANYBD_MISSING_CACHE'
    //     )
    //   })
    // })

    // context('when there was an instance already prepared', () => {
    //   before('prepare instance', async () => {
    //     await template.prepareInstance(SHARE_TOKEN_NAME, SHARE_TOKEN_SYMBOL, SHARE_VOTING_SETTINGS, BOARD_VOTING_SETTINGS)
    //   })

    //   it('reverts when no share members were given', async () => {
    //     await assertRevert(finalizeInstance(randomId(), [], SHARE_STAKES, BOARD_MEMBERS, FINANCE_PERIOD, USE_AGENT_AS_VAULT), 'COMPANYBD_MISSING_SHARE_MEMBERS')
    //   })

    //   it('reverts when number of shared members and stakes do not match', async () => {
    //     await assertRevert(
    //       finalizeInstance(randomId(), [shareHolder1], SHARE_STAKES, BOARD_MEMBERS, FINANCE_PERIOD, USE_AGENT_AS_VAULT),
    //       'COMPANYBD_BAD_HOLDERS_STAKES_LEN'
    //     )
    //     await assertRevert(
    //       finalizeInstance(randomId(), SHARE_HOLDERS, [1e18], BOARD_MEMBERS, FINANCE_PERIOD, USE_AGENT_AS_VAULT),
    //       'COMPANYBD_BAD_HOLDERS_STAKES_LEN'
    //     )
    //   })
    // })
  })

  context('when the creation succeeds', () => {
    let baseReceipt, fundraisingReceipt, finalizationReceipt

    const loadDAO = async (apps = { vault: false, agent: false, payroll: false }) => {
      dao = Kernel.at(getEventArgument(baseReceipt, 'DeployDao', 'dao'))
      acl = ACL.at(await dao.acl())

      boardToken = MiniMeToken.at(getEventArgument(baseReceipt, 'DeployToken', 'token', 0))
      shareToken = MiniMeToken.at(getEventArgument(fundraisingReceipt, 'DeployToken', 'token', 0))

      const installedAppsDuringPrepare = getInstalledAppsById(baseReceipt)
      const installedAppsDuringFinalize = getInstalledAppsById(fundraisingReceipt)

      assert.equal(installedAppsDuringPrepare['token-manager'].length, 1, 'should have installed 1 token-manager apps during prepare')
      assert.equal(installedAppsDuringFinalize['token-manager'].length, 1, 'should have installed 1 token-manager apps during finalize')
      boardTokenManager = TokenManager.at(installedAppsDuringPrepare['token-manager'][0])
      shareTokenManager = TokenManager.at(installedAppsDuringFinalize['token-manager'][0])

      assert.equal(installedAppsDuringPrepare.voting.length, 1, 'should have installed 1 voting apps during prepare')
      assert.equal(installedAppsDuringFinalize.voting.length, 1, 'should have installed 1 voting apps during finalize')
      boardVoting = Voting.at(installedAppsDuringPrepare.voting[0])
      shareVoting = Voting.at(installedAppsDuringFinalize.voting[0])

      // if (apps.vault) {
      assert.equal(installedAppsDuringPrepare.vault.length, 1, 'should have installed 1 vault app')
      vault = Vault.at(installedAppsDuringPrepare.vault[0])
      // }

      assert.equal(installedAppsDuringPrepare.finance.length, 1, 'should have installed 1 finance app')
      finance = Finance.at(installedAppsDuringPrepare.finance[0])

      assert.equal(installedAppsDuringFinalize.pool.length, 1, 'should have installed 1 pool app')
      reserve = Pool.at(installedAppsDuringFinalize.pool[0])

      assert.equal(installedAppsDuringFinalize['batched-bancor-market-maker'].length, 1, 'should have installed 1 market-maker app')
      marketMaker = MarketMaker.at(installedAppsDuringFinalize['batched-bancor-market-maker'][0])

      assert.equal(installedAppsDuringFinalize.tap.length, 1, 'should have installed 1 tap app')
      tap = Tap.at(installedAppsDuringFinalize.tap[0])

      assert.equal(installedAppsDuringFinalize['aragon-fundraising'].length, 1, 'should have installed 1 aragon-fundraising app')
      controller = Controller.at(installedAppsDuringFinalize['aragon-fundraising'][0])
    }

    const itCostsUpTo = expectedFinalizationCost => {
      const expectedPrepareCost = 6.5e6
      const expectedTotalCost = expectedPrepareCost + expectedFinalizationCost

      it(`gas costs must be up to ~${expectedTotalCost} gas`, async () => {
        const prepareCost = baseReceipt.receipt.gasUsed
        assert.isAtMost(prepareCost, expectedPrepareCost, `prepare call should cost up to ${expectedPrepareCost} gas`)

        const finalizeCost = fundraisingReceipt.receipt.gasUsed
        assert.isAtMost(finalizeCost, expectedFinalizationCost, `share setup call should cost up to ${expectedFinalizationCost} gas`)

        const totalCost = prepareCost + finalizeCost
        assert.isAtMost(totalCost, expectedTotalCost, `total costs should be up to ${expectedTotalCost} gas`)
      })
    }

    const itSetupsDAOCorrectly = financePeriod => {
      context('ENS', () => {
        it('registers a new DAO on ENS', async () => {
          const ens = ENS.at((await deployedAddresses()).registry)
          const aragonIdNameHash = namehash(`${daoID}.aragonid.eth`)
          const resolvedAddress = await PublicResolver.at(await ens.resolver(aragonIdNameHash)).addr(aragonIdNameHash)
          assert.equal(resolvedAddress, dao.address, 'aragonId ENS name does not match')
        })
      })

      context('DAO', () => {
        it('should have DAO and ACL permissions correctly setup ', async () => {
          await assertRole(acl, dao, shareVoting, 'APP_MANAGER_ROLE', shareVoting)
          await assertRole(acl, acl, shareVoting, 'CREATE_PERMISSIONS_ROLE', shareVoting)
        })
      })

      context('Board', () => {
        it('should have created a new board token', async () => {
          assert.equal(await boardToken.name(), BOARD_TOKEN_NAME)
          assert.equal(await boardToken.symbol(), BOARD_TOKEN_SYMBOL)
          assert.equal((await boardToken.decimals()).toString(), 0)
        })

        it('should have minted requested amounts for the board members', async () => {
          assert.equal((await boardToken.totalSupply()).toString(), BOARD_MEMBERS.length)
          for (const holder of BOARD_MEMBERS) assert.equal((await boardToken.balanceOf(holder)).toString(), 1)
        })

        it('should have board token manager app correctly setup', async () => {
          assert.isTrue(await boardTokenManager.hasInitialized(), 'token manager not initialized')
          assert.equal(await boardTokenManager.token(), boardToken.address)

          await assertRole(acl, boardTokenManager, boardVoting, 'MINT_ROLE')
          await assertRole(acl, boardTokenManager, boardVoting, 'BURN_ROLE')

          await assertMissingRole(acl, boardTokenManager, 'ISSUE_ROLE')
          await assertMissingRole(acl, boardTokenManager, 'ASSIGN_ROLE')
          await assertMissingRole(acl, boardTokenManager, 'REVOKE_VESTINGS_ROLE')
        })

        it('should have board voting app correctly setup', async () => {
          assert.isTrue(await boardVoting.hasInitialized(), 'voting not initialized')
          assert.equal((await boardVoting.supportRequiredPct()).toString(), BOARD_SUPPORT_REQUIRED)
          assert.equal((await boardVoting.minAcceptQuorumPct()).toString(), BOARD_MIN_ACCEPTANCE_QUORUM)
          assert.equal((await boardVoting.voteTime()).toString(), BOARD_VOTE_DURATION)

          await assertRole(acl, boardVoting, boardVoting, 'CREATE_VOTES_ROLE', boardTokenManager)
          await assertRole(acl, boardVoting, boardVoting, 'MODIFY_QUORUM_ROLE')
          await assertRole(acl, boardVoting, boardVoting, 'MODIFY_SUPPORT_ROLE')
        })

        it('should have vault app correctly setup', async () => {
          assert.isTrue(await vault.hasInitialized(), 'vault not initialized')

          assert.equal(await dao.recoveryVaultAppId(), APP_IDS.vault, 'vault app is not being used as the vault app of the DAO')
          assert.equal(web3.toChecksumAddress(await finance.vault()), vault.address, 'finance vault is not the vault app')
          assert.equal(web3.toChecksumAddress(await dao.getRecoveryVault()), vault.address, 'vault app is not being used as the vault app of the DAO')

          await assertRole(acl, vault, boardVoting, 'TRANSFER_ROLE', finance)
        })

        it('should have finance app correctly setup', async () => {
          assert.isTrue(await finance.hasInitialized(), 'finance not initialized')

          const expectedPeriod = financePeriod === 0 ? THIRTY_DAYS : financePeriod
          assert.equal((await finance.getPeriodDuration()).toString(), expectedPeriod, 'finance period should be 30 days')

          await assertRole(acl, finance, boardVoting, 'CREATE_PAYMENTS_ROLE')
          await assertRole(acl, finance, boardVoting, 'EXECUTE_PAYMENTS_ROLE')
          await assertRole(acl, finance, boardVoting, 'MANAGE_PAYMENTS_ROLE')

          await assertMissingRole(acl, finance, 'CHANGE_PERIOD_ROLE')
          await assertMissingRole(acl, finance, 'CHANGE_BUDGETS_ROLE')
        })
      })

      context('Share holders', () => {
        it('should have created a new share token', async () => {
          assert.equal(await shareToken.name(), SHARE_TOKEN_NAME)
          assert.equal(await shareToken.symbol(), SHARE_TOKEN_SYMBOL)
          assert.equal((await shareToken.decimals()).toString(), 18)
        })

        it('should have share token manager app correctly setup', async () => {
          assert.isTrue(await shareTokenManager.hasInitialized(), 'token manager not initialized')
          assert.equal(await shareTokenManager.token(), shareToken.address)

          await assertRole(acl, shareTokenManager, shareVoting, 'MINT_ROLE', marketMaker)
          await assertRole(acl, shareTokenManager, shareVoting, 'BURN_ROLE', marketMaker)

          await assertMissingRole(acl, shareTokenManager, 'ISSUE_ROLE')
          await assertMissingRole(acl, shareTokenManager, 'ASSIGN_ROLE')
          await assertMissingRole(acl, shareTokenManager, 'REVOKE_VESTINGS_ROLE')
        })

        it('should have share voting app correctly setup', async () => {
          assert.isTrue(await shareVoting.hasInitialized(), 'voting not initialized')
          assert.equal((await shareVoting.supportRequiredPct()).toString(), SHARE_SUPPORT_REQUIRED)
          assert.equal((await shareVoting.minAcceptQuorumPct()).toString(), SHARE_MIN_ACCEPTANCE_QUORUM)
          assert.equal((await shareVoting.voteTime()).toString(), SHARE_VOTE_DURATION)

          await assertRole(acl, shareVoting, shareVoting, 'CREATE_VOTES_ROLE', boardTokenManager)
          await assertRole(acl, shareVoting, shareVoting, 'MODIFY_QUORUM_ROLE')
          await assertRole(acl, shareVoting, shareVoting, 'MODIFY_SUPPORT_ROLE')
        })
      })

      // CHECK LINKED CONTRACTS ?

      context('Fundraising apps', () => {
        it('should have agent / reserve app correctly setup', async () => {
          assert.isTrue(await reserve.hasInitialized(), 'agent / reserve not initialized')

          assert.equal(await reserve.protectedTokens(0), COLLATERAL_1.address, 'DAI not protected')
          assert.equal(await reserve.protectedTokens(1), COLLATERAL_2.address, 'ANT not protected')

          await assertRole(acl, reserve, shareVoting, 'SAFE_EXECUTE_ROLE', shareVoting)
          await assertRole(acl, reserve, shareVoting, 'ADD_PROTECTED_TOKEN_ROLE', controller)
          await assertRole(acl, reserve, shareVoting, 'TRANSFER_ROLE', marketMaker)
          await assertRole(acl, reserve, shareVoting, 'TRANSFER_ROLE', tap)

          await assertMissingRole(acl, reserve, 'REMOVE_PROTECTED_TOKEN_ROLE')
          await assertMissingRole(acl, reserve, 'EXECUTE_ROLE')
          await assertMissingRole(acl, reserve, 'DESIGNATE_SIGNER_ROLE')
          await assertMissingRole(acl, reserve, 'ADD_PRESIGNED_HASH_ROLE')
          await assertMissingRole(acl, reserve, 'RUN_SCRIPT_ROLE')
        })

        it('should have market-maker app correctly setup', async () => {
          assert.isTrue(await marketMaker.hasInitialized(), 'market-maker not initialized')

          const dai = await marketMaker.getCollateralToken(COLLATERAL_1.address)
          const ant = await marketMaker.getCollateralToken(COLLATERAL_1.address)

          assert.isTrue(dai[0], 'DAI not whitelisted')
          assert.equal(dai[1].toNumber(), VIRTUAL_SUPPLIES[0], 'DAI virtual supply should be ' + VIRTUAL_SUPPLIES[0])
          assert.equal(dai[2].toNumber(), VIRTUAL_BALANCES[0], 'DAI virtual balance should be ' + VIRTUAL_BALANCES[0])
          assert.equal(dai[3].toNumber(), RESERVE_RATIOS[0], 'DAI reserve ratio should be ' + RESERVE_RATIOS[0])
          assert.equal(dai[4].toNumber(), SLIPPAGES[0], 'DAI maximum slippage should be ' + SLIPPAGES[0])

          assert.isTrue(ant[0], 'ANT not whitelisted')
          assert.equal(ant[1].toNumber(), VIRTUAL_SUPPLIES[1], 'ANT virtual supply should be ' + VIRTUAL_SUPPLIES[1])
          assert.equal(ant[2].toNumber(), VIRTUAL_BALANCES[1], 'ANT virtual balance should be ' + VIRTUAL_BALANCES[1])
          assert.equal(ant[3].toNumber(), RESERVE_RATIOS[1], 'ANT reserve ratio should be ' + RESERVE_RATIOS[1])
          assert.equal(ant[4].toNumber(), SLIPPAGES[1], 'ANT maximum slippage should be ' + SLIPPAGES[1])

          await assertRole(acl, marketMaker, shareVoting, 'ADD_COLLATERAL_TOKEN_ROLE', controller)
          await assertRole(acl, marketMaker, shareVoting, 'REMOVE_COLLATERAL_TOKEN_ROLE', controller)
          await assertRole(acl, marketMaker, shareVoting, 'UPDATE_COLLATERAL_TOKEN_ROLE', controller)
          await assertRole(acl, marketMaker, shareVoting, 'UPDATE_BENEFICIARY_ROLE', controller)
          await assertRole(acl, marketMaker, shareVoting, 'UPDATE_FEES_ROLE', controller)
          await assertRole(acl, marketMaker, shareVoting, 'OPEN_BUY_ORDER_ROLE', controller)
          await assertRole(acl, marketMaker, shareVoting, 'OPEN_SELL_ORDER_ROLE', controller)

          await assertMissingRole(acl, marketMaker, 'UPDATE_FORMULA_ROLE')
        })

        it('should have tap app correctly setup', async () => {
          assert.isTrue(await tap.hasInitialized(), 'tap not initialized')

          assert.equal((await tap.taps(COLLATERAL_1.address)).toNumber(), TAPS[0], 'DAI tap should be ' + TAPS[0])
          assert.equal((await tap.taps(COLLATERAL_2.address)).toNumber(), TAPS[1], 'ANT tap should be ' + TAPS[1])
          assert.equal((await tap.floors(COLLATERAL_1.address)).toNumber(), FLOORS[0], 'DAI floor should be ' + FLOORS[0])
          assert.equal((await tap.floors(COLLATERAL_1.address)).toNumber(), FLOORS[0], 'ANT floor should be ' + FLOORS[1])

          await assertRole(acl, tap, shareVoting, 'UPDATE_BENEFICIARY_ROLE', controller)
          await assertRole(acl, tap, shareVoting, 'UPDATE_MAXIMUM_TAP_INCREASE_PCT_ROLE', controller)
          await assertRole(acl, tap, shareVoting, 'ADD_TAPPED_TOKEN_ROLE', controller)
          await assertRole(acl, tap, shareVoting, 'UPDATE_TAPPED_TOKEN_ROLE', controller)
          await assertRole(acl, tap, boardVoting, 'WITHDRAW_ROLE', controller)

          await assertMissingRole(acl, tap, 'UPDATE_CONTROLLER_ROLE')
          await assertMissingRole(acl, tap, 'UPDATE_RESERVE_ROLE')
          await assertMissingRole(acl, tap, 'REMOVE_TAPPED_TOKEN_ROLE')
        })

        it('should have aragon-fundraising app correctly setup', async () => {
          assert.isTrue(await controller.hasInitialized(), 'aragon-fundraising not initialized')

          await assertRole(acl, controller, boardVoting, 'UPDATE_BENEFICIARY_ROLE', boardVoting)
          await assertRole(acl, controller, boardVoting, 'WITHDRAW_ROLE', boardVoting)
          await assertRole(acl, controller, shareVoting, 'UPDATE_FEES_ROLE', shareVoting)
          await assertRole(acl, controller, shareVoting, 'UPDATE_MAXIMUM_TAP_INCREASE_PCT_ROLE', shareVoting)
          await assertRole(acl, controller, shareVoting, 'ADD_COLLATERAL_TOKEN_ROLE', shareVoting)
          await assertRole(acl, controller, shareVoting, 'REMOVE_COLLATERAL_TOKEN_ROLE', shareVoting)
          await assertRole(acl, controller, shareVoting, 'UPDATE_COLLATERAL_TOKEN_ROLE', shareVoting)
          await assertRole(acl, controller, shareVoting, 'UPDATE_TOKEN_TAP_ROLE', shareVoting)
          await assertRole(acl, controller, shareVoting, 'OPEN_BUY_ORDER_ROLE', ANY_ADDRESS)
          await assertRole(acl, controller, shareVoting, 'OPEN_SELL_ORDER_ROLE', ANY_ADDRESS)
        })
      })

      // it('sets up EVM scripts registry permissions correctly', async () => {
      //   const reg = await EVMScriptRegistry.at(await acl.getEVMScriptRegistry())
      //   await assertRole(acl, reg, shareVoting, 'REGISTRY_ADD_EXECUTOR_ROLE')
      //   await assertRole(acl, reg, shareVoting, 'REGISTRY_MANAGER_ROLE')
      // })
    }

    const createDAO = (useAgentAsVault, financePeriod) => {
      before('create fundraising entity with multisig', async () => {
        daoID = randomId()
        baseReceipt = await template.deployBaseInstance(BOARD_TOKEN_NAME, BOARD_TOKEN_SYMBOL, BOARD_MEMBERS, BOARD_VOTING_SETTINGS, financePeriod, {
          from: owner,
        })
        fundraisingReceipt = await template.installFundraisingApps(daoID, SHARE_TOKEN_NAME, SHARE_TOKEN_SYMBOL, SHARE_VOTING_SETTINGS, { from: owner })
        finalizationReceipt = await template.finalizeInstance(COLLATERALS, VIRTUAL_BALANCES, SLIPPAGES, TAPS, FLOORS, {
          from: owner,
        })

        dao = Kernel.at(getEventArgument(baseReceipt, 'DeployDao', 'dao'))
        boardToken = MiniMeToken.at(getEventArgument(baseReceipt, 'DeployToken', 'token', 0))
        shareToken = MiniMeToken.at(getEventArgument(fundraisingReceipt, 'DeployToken', 'token', 0))
        await loadDAO({ vault: !useAgentAsVault, agent: useAgentAsVault })
      })
    }

    context('when requesting a custom finance period', () => {
      const FINANCE_PERIOD = 60 * 60 * 24 * 15 // 15 days

      // context('when requesting an agent app', () => {
      //   const USE_AGENT_AS_VAULT = true

      //   createDAO(USE_AGENT_AS_VAULT, FINANCE_PERIOD)
      //   itCostsUpTo(4.4e6)
      //   itSetupsDAOCorrectly(FINANCE_PERIOD)
      //   itSetupsAgentAppCorrectly()
      // })

      context('when requesting a vault app', () => {
        const USE_AGENT_AS_VAULT = false

        createDAO(USE_AGENT_AS_VAULT, FINANCE_PERIOD)
        itCostsUpTo(6.5e6)
        itSetupsDAOCorrectly(FINANCE_PERIOD)
        // itSetupsVaultAppCorrectly()
      })
    })

    context('when requesting a default finance period', () => {
      const FINANCE_PERIOD = 0 // use default

      // context('when requesting an agent app', () => {
      //   const USE_AGENT_AS_VAULT = true

      //   createDAO(USE_AGENT_AS_VAULT, FINANCE_PERIOD)
      //   itCostsUpTo(4.4e6)
      //   itSetupsDAOCorrectly(FINANCE_PERIOD)
      //   itSetupsAgentAppCorrectly()
      // })

      context('when requesting a vault app', () => {
        const USE_AGENT_AS_VAULT = false

        createDAO(USE_AGENT_AS_VAULT, FINANCE_PERIOD)
        itCostsUpTo(6.6e6)
        itSetupsDAOCorrectly(FINANCE_PERIOD)
        // itSetupsVaultAppCorrectly()
      })
    })
  })
})
