import { CosmosEvent } from "@subql/types-cosmos";

export type GetIdFromEventAttribute = (attributes: CosmosEvent["event"]["attributes"]) => string | Array<string>;

export type RecordGetId = Record<string, string | GetIdFromEventAttribute>
