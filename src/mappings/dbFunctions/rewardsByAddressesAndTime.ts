// The get_rewards_* functions kept their names, arguments and return types, and now answer from the money tables:
// each returns the data of its legacy_* twin (settlement/functions.ts), which holds what the function returned while it
// read mod_to_acct_transfers (that table is no longer written). They are plpgsql so that they resolve the legacy_*
// function when called, not when created. A scalar reads 0 where the twin has nothing covered, as it did with no rows.
// Only the twin's data is returned, not its range: a part of the range the money tables do not cover reads as nothing, as
// the unwritten part of mod_to_acct_transfers would. The money tables cover mainnet from height 1 to the tip (checked
// 2026-10-16), so this is the same answer there; call the legacy_* function for the range and the gaps.
export function getRewardsByAddressesAndTimeGroupByDate(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_addresses_and_time_group_by_date(
    addresses TEXT[],
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    trunc_interval TEXT  -- 'day' or 'hour'
)
RETURNS JSON AS $$
BEGIN
    RETURN (${dbSchema}.legacy_rewards_by_addresses_and_time_group_by_date(addresses, start_date, end_date, trunc_interval)->>'data')::json;
END;
$$ LANGUAGE plpgsql STABLE;`
}

export function getRewardsByAddressesAndTime(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_addresses_and_time(
    addresses TEXT[],
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS NUMERIC AS $$
BEGIN
    RETURN COALESCE((${dbSchema}.legacy_rewards_by_addresses_and_time(addresses, start_date, end_date)->>'data')::NUMERIC, 0);
END;
$$ LANGUAGE plpgsql STABLE;`
}

export function getRewardsByAddressesAndTimeGroupByDateAndAddress(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_addresses_and_time_group_by_address_and_date(
    addresses TEXT[],
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    trunc_interval TEXT  -- 'day' or 'hour'
)
RETURNS JSON AS $$
BEGIN
    RETURN (${dbSchema}.legacy_rewards_by_addresses_and_time_group_by_address_and_date(addresses, start_date, end_date, trunc_interval)->>'data')::json;
END;
$$ LANGUAGE plpgsql STABLE;`
}

export function getRewardsBySuppliersAndTime(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_of_addresses_by_suppliers_and_time(
    addresses TEXT[],
    supplier_addresses TEXT[],
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS NUMERIC AS $$
BEGIN
    RETURN COALESCE((${dbSchema}.legacy_rewards_of_addresses_by_suppliers_and_time(addresses, supplier_addresses, start_date, end_date)->>'data')::NUMERIC, 0);
END;
$$ LANGUAGE plpgsql STABLE;`
}

export function getRewardsBySuppliersAndTimeGroupByDateAndAddress(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_suppliers_and_time_group_by_address_and_date(
    addresses TEXT[],
    supplier_addresses TEXT[],
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    trunc_interval TEXT  -- 'day' or 'hour'
)
RETURNS JSON AS $$
BEGIN
    RETURN (${dbSchema}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(addresses, supplier_addresses, start_date, end_date, trunc_interval)->>'data')::json;
END;
$$ LANGUAGE plpgsql STABLE;`
}
