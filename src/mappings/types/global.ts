import { IStoreModelProvider, Context } from "@subql/node-core";
import type {
  Entity,
  GetOptions,
  Store,
} from "@subql/types-core";

// Redefine the `getByFields` method globally, fixing type mismatch issues
declare global {
  type FixedStore = Store & Omit<Store, "getByField" | "getByFields"> & {
    // // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // // @ts-ignore
    modelProvider: IStoreModelProvider;
    // // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // // @ts-ignore
    context: Context;
    getByField<T extends Entity>(
      entity: string,
      field: string,
      value: never,
      options?: GetOptions<T>,
    ): Promise<T[]>;
  };

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const store: FixedStore;
}
