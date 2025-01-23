import {
  FunctionPropertyNames,
  GetOptions,
} from "@subql/types-core";
import { SupplyDenom } from "../../types";

type EntityProps<T> = Omit<SupplyDenom, NonNullable<FunctionPropertyNames<T>> | "_name">

type PaginatedFetchOptions<T> = {
  // Function to fetch data
  fetchFn: (options: GetOptions<EntityProps<T>>) => Promise<T[]>;
  // Initial options without offset (limit required)
  initialOptions?: Partial<GetOptions<EntityProps<T>>>;
};

/**
 * Fetch all paginated records using offset, stopping when there are no more records.
 */
export async function fetchPaginatedRecords<T>({
                                                 fetchFn,
                                                 initialOptions,
                                               }: PaginatedFetchOptions<T>): Promise<T[]> {
  let results: T[] = [];
  const fetchFnName = fetchFn.name; // Get the function name for logging
  const logPrefix = `[fetchPaginated.${fetchFnName}]`; // Reusable log prefix
  logger.info(`${logPrefix} Starting paginated fetch`);

  let offset = 0; // Initialize offset to 0
  let batch: T[]; // Placeholder for the currently fetched batch

  do {
    logger.info(
      `${logPrefix} Fetching batch with options: ${JSON.stringify({
        ...(initialOptions || {}),
        offset,
      })}`,
    );

    // Fetch the current batch of results
    batch = await fetchFn({ ...initialOptions as GetOptions<EntityProps<T>>, offset });

    // Append batch to results
    results = results.concat(batch);

    logger.info(
      `${logPrefix} Fetched ${batch.length} records. Total records so far: ${results.length}`,
    );

    // Increment the offset by the number of elements in the current batch
    offset += batch.length;

    // Continue until there are no more records in the current batch
  } while (batch.length > 0);

  logger.info(`${logPrefix} Completed paginated fetch. Total records fetched: ${results.length}`);
  return results;
}
