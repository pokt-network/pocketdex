import {
  BaseEntity,
  IModel,
} from "@subql/node-core";
import {
  FunctionPropertyNames,
  GetOptions,
} from "@subql/types-core";
import type {
  BulkCreateOptions,
  Sequelize,
} from "@subql/x-sequelize";
import { isNumber } from "lodash";
import pLimit from "p-limit";
import type { SupplyDenom } from "../../types";

type EntityProps<T> = Omit<SupplyDenom, NonNullable<FunctionPropertyNames<T>> | "_name">

type PaginatedFetchOptions<T> = {
  // Function to fetch data
  fetchFn: (options: GetOptions<EntityProps<T>>) => Promise<T[]>;
  // Initial options without offset (limit required)
  initialOptions?: Partial<GetOptions<EntityProps<T>>>;
};

type Transformer<T> = (doc: T) => any;

// PAGE_LIMIT should be less or equal to --query-limit=<value> otherwise Subql will throw an error.
const PAGE_LIMIT = isNumber(process.env.POCKETDEX_DB_PAGE_LIMIT) ? Number(process.env.POCKETDEX_DB_PAGE_LIMIT) : 1000;
const BATCH_SIZE = isNumber(process.env.POCKETDEX_DB_BATCH_SIZE) ? Number(process.env.POCKETDEX_DB_BATCH_SIZE) : 15000;
const CONCURRENCY = isNumber(process.env.POCKETDEX_DB_BULK_WRITE_CONCURRENCY) ? Number(process.env.POCKETDEX_DB_BULK_WRITE_CONCURRENCY) : 10;


/**
 * Retrieves the store model associated with the given name.
 *
 * @param {string} name - The name of the model to retrieve.
 * @return {IModel<BaseEntity>} The corresponding store model.
 */
export function getStoreModel(name: string): IModel<BaseEntity> {
  return store.modelProvider.getModel(name);
}

/**
 * Retrieves the Sequelize instance associated with the specified model name.
 *
 * @param {string} name - The name of the model for which to retrieve the Sequelize instance.
 * @return {Sequelize} The Sequelize instance corresponding to the provided model name.
 */
export function getSequelize(name: string): Sequelize {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return getStoreModel(name).model.sequelize!;
}

/**
 * Fetches paginated records using a provided fetch function and options.
 * This method continually retrieves records in batches until all records are fetched.
 *
 * @param {Object} params The parameters for fetching paginated records.
 * @param {function} params.fetchFn A function responsible for fetching a batch of records. It should support options such as offset and limit.
 * @param {Object} [params.initialOptions] An optional object containing initial options to pass to the fetch function.
 *
 * @return {Promise<T[]>} A promise that resolves to an array of all fetched records.
 */
export async function fetchPaginatedRecords<T>({
                                                 fetchFn,
                                                 initialOptions,
                                               }: PaginatedFetchOptions<T>): Promise<T[]> {
  let results: T[] = [];
  const fetchFnName = fetchFn.name; // Get the function name for logging
  const logPrefix = `[fetchPaginated.${fetchFnName}]`; // Reusable log prefix

  let offset = 0; // Initialize offset to 0
  let batch: T[]; // Placeholder for the currently fetched batch

  do {
    logger.debug(
      `${logPrefix} Fetching batch with options: ${JSON.stringify({
        ...(initialOptions || {}),
        offset,
        limit: PAGE_LIMIT, // we need to be sure that --query-limit=1000 is passed to the node-cosmos cli
      })}`,
    );

    // Fetch the current batch of results
    batch = await fetchFn({ ...initialOptions as GetOptions<EntityProps<T>>, offset });

    // Append batch to results
    results = results.concat(batch);

    logger.debug(
      `${logPrefix} Fetched ${batch.length} records. Total records so far: ${results.length}`,
    );

    // Increment the offset by the number of elements in the current batch
    offset += batch.length;

    // Continue until there are no more records in the current batch or if the result is lower than limit, which mean
    // there are no more records to load.
  } while (batch.length === PAGE_LIMIT);

  logger.debug(`${logPrefix} Completed paginated fetch. Total records fetched: ${results.length}`);
  return results;
}

/**
 * Performs an optimized bulk creation of records for the specified model in batches.
 *
 * This method processes the provided documents (`docs`) in chunks of a defined batch size to manage memory usage
 * and improve performance in scenarios with a large number of records.
 * Each document can be processed through an optional transformer function before being saved.
 * Additionally, custom bulk creation options can be provided.
 *
 * @param {string} modelName - The name of the model for which the records are being created.
 * @param {Array<any>} docs - An array of document objects to be saved in bulk.
 * @param {function(any): any} [transformer] - An optional function to transform each document before saving.
 * @param {BulkCreateOptions<BaseEntity>} [bulkCreateOpts] - Optional configuration options for the bulk creation process.
 * @return {Promise<void>} A promise that resolves once all records have been successfully created.
 */
// NOTE: Leave this here in case something go wrong, but the new one is well tested locally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// export async function optimizedBulkCreate(modelName: string, docs: Array<any>, transformer?: (item: any) => any, bulkCreateOpts?: BulkCreateOptions<BaseEntity>): Promise<void> {
//   if (docs.length === 0) return; // avoid the need of caller validate length before call this.
//   logger.debug(
//     `[optimizedBulkCreate] Initiating bulk creation for model: '${modelName}'. Total records: ${docs.length}, Batch size: ${BATCH_SIZE}.`,
//   );
//
//   let totalSaved = 0;
//
//   const model = store.modelProvider.getModel(modelName).model
//
//   for (let batchStart = 0; batchStart < docs.length; batchStart += BATCH_SIZE) {
//     const records: Array<EventProps> = [];
//
//     for (let i = 0; i < BATCH_SIZE; i++) {
//       const docIndex = batchStart + i;
//       if (docIndex >= docs.length) break;
//       const doc = transformer ? transformer(docs[docIndex]) : docs[docIndex];
//       if (!doc._block_range) doc._block_range = [store.context.getHistoricalUnit(), null];
//       records.push(doc);
//     }
//
//     // Improved progress log for each batch
//     logger.debug(
//       `[optimizedBulkCreate] Processing batch: Start index = ${batchStart}, Records in batch = ${records.length}, Remaining records = ${docs.length - batchStart - records.length}.`,
//     );
//
//     // TODO(@Alann27): Instead of creating a transaction for each batch, we should create a transaction for multiple bashes
//     const transaction = await model.sequelize!.transaction({
//       logging: false
//     })
//
//     try {
//       // Perform the bulk creation
//       await model.bulkCreate(records, {
//         transaction,
//         ignoreDuplicates: true,
//         ...bulkCreateOpts,
//       });
//
//       await transaction.commit()
//     } catch (e) {
//       await transaction.rollback()
//       throw e
//     }
//
//     // Update and log progress after successful batch creation
//     totalSaved += records.length;
//     logger.debug(
//       `[optimizedBulkCreate] Successfully saved batch starting at index ${batchStart}. Total saved so far: ${totalSaved}/${docs.length}.`,
//     );
//   }
//
//   logger.debug(`[optimizedBulkCreate] Bulk creation complete: All ${docs.length} '${modelName}' records saved.`);
// }

/**
 * High-throughput, memory-efficient parallel bulk insert with optional transformation and _block_range enforcement.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function optimizedBulkCreate<T>(
  modelName: string,
  docs: T[],
  transformer?: Transformer<T>,
  bulkCreateOpts?: BulkCreateOptions<BaseEntity>,
): Promise<void> {
  if (docs.length === 0) return; // avoid the need of caller validate length before call this.
  logger.info(
    `[optimizedBulkCreate] Initiating bulk creation for model: '${modelName}'. Total records: ${docs.length}, Batch size: ${BATCH_SIZE}, Concurrency: ${CONCURRENCY}.`,
  );
  const model = store.modelProvider.getModel(modelName).model
  const limit = pLimit(CONCURRENCY);

  const batches: any[][] = [];
  let currentBatch: any[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = transformer ? transformer(docs[i]) : docs[i];
    if (!doc._block_range) {
      doc._block_range = [store.context.getHistoricalUnit(), null];
    }

    currentBatch.push(doc);

    if (currentBatch.length === BATCH_SIZE || i === docs.length - 1) {
      batches.push(currentBatch);
      currentBatch = [];
    }
  }

  const tasks = batches.map((batch, index) =>
    limit(async () => {
      try {
        await model.sequelize!.transaction({ logging: false }, async (tx) => {
          await model.bulkCreate(batch, {
            transaction: tx,
            ignoreDuplicates: true,
            ...bulkCreateOpts,
          });
        });
        logger.info(`[optimizedBulkCreate] ${modelName} batch ${index + 1}/${batches.length} inserted`);
      } catch (err) {
        logger.error(`[optimizedBulkCreate] ${modelName} batch batch ${index + 1}/${batches.length} failed`);
        throw err;
      }
    }),
  );

  await Promise.all(tasks);
}
