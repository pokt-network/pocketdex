import { createHash } from "crypto";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { UnprocessedEntity } from "../../types";
import { messageId } from "./ids";
import {
  Primitive,
  Primitives,
  primitivesFromEvent,
  primitivesFromMsg,
} from "./primitives";

export async function attemptHandling(
  input: Primitive,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlerFn: (primitive: any) => Promise<void>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errorFn: (Error: Error, Primitive: any) => Promise<void> | void,
): Promise<void> {
  try {
    await handlerFn(input);
  } catch (error: unknown) {
    await errorFn(error as Error, input);
  }
}

export async function unprocessedEventHandler(err: Error, event: CosmosEvent): Promise<void> {
  await trackUnprocessed(err, primitivesFromEvent(event));
}

export async function unprocessedMsgHandler(err: Error, msg: CosmosMessage): Promise<void> {
  await trackUnprocessed(err, primitivesFromMsg(msg));
}

export async function trackUnprocessed(error: Error, primitives: Primitives): Promise<void> {
  logger.warn(`[trackUnprocessable] (error.message): ${error.message}`);
  logger.warn(`[trackUnprocessable] (error.stack): ${error.stack}`);
  // NB: failsafe try/catch
  try {
    const { block, event, msg, tx } = primitives;
    const sha256 = createHash("sha256");
    // NB: use error stack if no primitives available (i.e. block handler).
    const hashInput = event ?
      (event.tx ? messageId(event) : `${event.block.blockId}-${event.idx}`) : msg ?
        // messageId(event) : msg ?
        messageId(msg) : tx ?
          tx.hash : block ?
            block.block.id : error.stack;
    sha256.write(hashInput);
    sha256.end();
    // NB: ID is a base64 encoded representation of the sha256 of either:
    // 1. the conventional ID of the "highest-level" primitive available or
    // 2. the error stacktrace, if none are available (i.e., handle block error)
    const id = sha256.read().toString("base64");
    const eventId = event ? messageId(event) : undefined;
    const _messageId = event ? messageId(event) : undefined;
    const transactionId = tx ? tx.hash : undefined;
    const blockId = block ? block.block.id : "";

    const unprocessedEntity = UnprocessedEntity.create({
      id,
      error: error.stack || "",
      eventId,
      messageId: _messageId,
      transactionId,
      blockId: blockId,
    });
    return await unprocessedEntity.save();
  } catch {
    logger.error("[trackUnprocessable] (ERROR): unable to persist unprocessable entity");
    logger.error(`[trackUnprocessable] (ERROR | stack): ${error.stack}`);
  }
}
