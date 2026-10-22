import { CosmosBlock } from "@subql/types-cosmos";
import { refreshDomainServiceDailyRewardsFnName } from "../dbFunctions/domainRewards";
import { updateBlockReportsFnName } from "../dbFunctions/reports";
import { upsertAppsByBlockAndServicesFnName } from "../dbFunctions/reports/apps";
import { upsertRelaysByBlockAndServicesFnName } from "../dbFunctions/reports/relays";
import { upsertSuppliersByBlockAndServicesFnName } from "../dbFunctions/reports/suppliers";
import {
  finalizeSessionRostersFnName,
  sessionRosterInputsFnName,
  writeSessionRostersFnName,
} from "../dbFunctions/sessionRosters";
import { refreshSupplyDailyFnName } from "../dbFunctions/supplyDaily";
import { refreshTxCountsDailyFnName } from "../dbFunctions/txCounts";
import { blockTransaction, getDbSchema, getSequelize } from "../utils/db";
import {
  buildSessionRosters,
  SessionRosterInputs,
  sessionRostersFromHeight,
  writeClaimsWithoutRoster,
} from "./sessionRosters";

export async function handleAddBlockReports(block: CosmosBlock): Promise<void> {
  try {
    logger.info(`[handleAddBlockReports] Generating block #${block.header.height} reports...`);

    const sequelize = getSequelize('Block')
    const dbSchema = getDbSchema()

    const defaultOptions = {
      // whe need to run it in the subql transaction, otherwise it will not find the block, and the function will do nothing
      transaction: blockTransaction(),
      // to avoid sequelize try to format the results; this function returns a void, so this is not needed
      raw: true,
      // runs directly in the write pool
      useMaster: true,
    }

    const hasClaimSettled = block.events.some(e => e.event.type === 'pocket.tokenomics.EventClaimSettled');
    const height = block.header.height;

    // we can run those functions in parallel because they do not modify the same records
    await Promise.all([
      // mutate current block
      sequelize.query(`SELECT ${dbSchema}.${updateBlockReportsFnName}(${height}::bigint);`, defaultOptions),
      // insert new records of suppliers by services and block
      sequelize.query(`SELECT ${dbSchema}.${upsertSuppliersByBlockAndServicesFnName}(${height}::bigint);`, defaultOptions),
      // insert new records of apps by services and block
      sequelize.query(`SELECT ${dbSchema}.${upsertAppsByBlockAndServicesFnName}(${height}::bigint);`, defaultOptions),
      // insert new records of relays by services and block
      sequelize.query(`SELECT ${dbSchema}.${upsertRelaysByBlockAndServicesFnName}(${height}::bigint);`, defaultOptions),
      // rewrite this block's row of claims_by_block (claims created, settled and expired in it)
      sequelize.query(`SELECT ${dbSchema}.write_claims_by_block(${height}::bigint, ${height}::bigint);`, defaultOptions),
      // add this block's transactions to its day's counts by message type and status (get_tx_counts)
      sequelize.query(`SELECT ${dbSchema}.${refreshTxCountsDailyFnName}(${height}::bigint);`, defaultOptions),
      // write the days that closed before this block at their last block (get_supply, get_supply_composition)
      sequelize.query(`SELECT ${dbSchema}.${refreshSupplyDailyFnName}(${height}::bigint);`, defaultOptions),
      // refresh domain+service daily rewards summary — only on blocks with settlements
      hasClaimSettled && sequelize.query(`SELECT ${dbSchema}.${refreshDomainServiceDailyRewardsFnName}(${height}::bigint);`, defaultOptions),
    ].filter(Boolean))

    // session rosters: at a session start, every session of it with its members; at every block, the final states of
    // the sessions it settles (after the money tables of the block, which indexMoney wrote before the reports)
    const rostersFrom = sessionRostersFromHeight(block.header.chainId);
    if (height >= rostersFrom) {
      const [inputs] = (await sequelize.query(`SELECT * FROM ${dbSchema}.${sessionRosterInputsFnName}(${height}::bigint);`,
        { ...defaultOptions, raw: true, plain: false })) as unknown as [Array<SessionRosterInputs & { is_start: boolean }>];
      if (inputs[0]?.is_start) {
        await sequelize.query(`SELECT ${dbSchema}.${writeSessionRostersFnName}($1::jsonb);`,
          { ...defaultOptions, bind: [JSON.stringify(buildSessionRosters(height, inputs[0]))] });
      }
      // the sessions of this block's claims that have no roster (an application staked during the session): written
      // now with the start's suppliers, as the chain validated the claims (_claims_without_roster); only blocks with claims
      // (an authz MsgExec may carry them)
      if (block.messages.some((m) => ["/pocket.proof.MsgCreateClaim", "/cosmos.authz.v1beta1.MsgExec"].includes(m.msg.typeUrl))) {
        const run = async (sql: string, params: unknown[]) =>
          ((await sequelize.query(sql, { ...defaultOptions, raw: true, plain: false, bind: params })) as unknown as [
            Array<Record<string, unknown>>,
          ])[0];
        const late = await writeClaimsWithoutRoster(run, dbSchema, height, height, rostersFrom);
        if (late.unmatched.length > 0) {
          logger.warn(`[handleAddBlockReports] block #${height}: claims of sessions whose roster could not be reproduced: ${late.unmatched.join(", ")}`);
        }
      }
      await sequelize.query(`SELECT ${dbSchema}.${finalizeSessionRostersFnName}(${height}::bigint);`, defaultOptions);
      await sequelize.query(`SELECT ${dbSchema}._session_roster_progress(${height}::bigint);`, defaultOptions);
    }
  } catch (e) {
    logger.error(`[handleAddBlockReports] Error generating block #${block.header.height} reports: ${e}`);
    throw e;
  }
}
