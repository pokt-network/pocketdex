import { getSequelize } from "../utils/db";

const getRelaysByServicePerPointJsonFn = (dbSchema: string) => `CREATE OR REPLACE FUNCTION ${dbSchema}.get_relays_by_service_per_point_json(
    start_timestamp TIMESTAMP,
    end_timestamp TIMESTAMP,
    trunc_interval TEXT  -- 'day' or 'hour'
)
RETURNS TEXT AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'date_truncated', date_truncated,
                'service_id', service_id,
                'relays', relays,
                'computed_units', computed_units,
                'claimed_upokt', claimed_upokt
            )
            ORDER BY date_truncated
        )::text
        FROM (
            SELECT 
                date_trunc(trunc_interval, b.timestamp) AS date_truncated, 
                r.service_id, 
                SUM(r.relays)::NUMERIC AS relays, 
                SUM(r.computed_units)::NUMERIC AS computed_units, 
                SUM(r.claimed_upokt)::NUMERIC AS claimed_upokt
            FROM ${dbSchema}.relay_by_block_and_services r
            INNER JOIN ${dbSchema}.blocks b ON b.id = r.block_id
            WHERE b.timestamp BETWEEN start_timestamp AND end_timestamp
            GROUP BY date_truncated, r.service_id
            ORDER BY date_truncated
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;`

const getSuppliersStakedAndBlocksByPointJsonFn = (dbSchema: string) => `CREATE OR REPLACE FUNCTION ${dbSchema}.get_suppliers_staked_and_blocks_by_point_json(
    start_timestamp TIMESTAMP,
    end_timestamp TIMESTAMP,
    trunc_interval TEXT  -- 'day' or 'hour'
)
RETURNS TEXT AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'date_truncated', date_truncated,
                'service_id', service_id,
                'amount', amount,
                'tokens', tokens,
                'blocks', blocks
            )
            ORDER BY date_truncated DESC, amount DESC
        )::text
        FROM (
            SELECT 
                date_trunc(trunc_interval, b.timestamp) date_truncated, 
                s.service_id, 
                SUM(s.amount)::NUMERIC amount, 
                SUM(s.tokens)::NUMERIC tokens, 
                COUNT(b.id)::NUMERIC blocks
            FROM ${dbSchema}.staked_suppliers_by_block_and_services s
            INNER JOIN ${dbSchema}.blocks b ON b.id = s.block_id
            WHERE b.timestamp BETWEEN start_timestamp AND end_timestamp
            GROUP BY date_truncated, s.service_id
            ORDER BY date_truncated DESC, amount DESC
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;`

const functionsCreatedCacheKey = 'functionsCreated';

export async function createDbFunctions(): Promise<void> {
  const wereFunctionsCreated = await cache.get(functionsCreatedCacheKey)

  if (wereFunctionsCreated) return

  logger.debug('[createDbFunctions] creating db functions: get_relays_by_service_per_point_json, get_suppliers_staked_and_blocks_by_point_json')

  const sequelize = getSequelize("Block")
  // here is the db schema, we need it to create the functions in that schema
  // @ts-ignore
  const schema = store.context.config?.dbSchema

  await sequelize.query(`
   ${getRelaysByServicePerPointJsonFn(schema)}
   ${getSuppliersStakedAndBlocksByPointJsonFn(schema)}
  `)

  logger.info(`[createDbFunctions] db functions were saved successfully to schema=${schema}.`)

  await cache.set(functionsCreatedCacheKey, true)
}
