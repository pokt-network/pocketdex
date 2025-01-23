import type {
  Entity,
  FunctionPropertyNames,
  GetOptions,
  Store,
} from "@subql/types-core";

// Augment the module without causing duplicate identifier issues
export type EntityProps<T> = Omit<T, NonNullable<FunctionPropertyNames<T>> | "_name">;
//
// declare module '@subql/types-core' {
//   // Modify the GetOptions type by extending and making 'limit' optional
//   export interface GetOptions<T> {
//     /**
//      * The number of items to return, if this exceeds the query-limit flag, it will throw
//      * NOTE: Changed to optional so we do not need to specify it each time and let it be whatever is defined using
//      * --query-limit param
//      */
//     limit?: number;
//     offset?: number;
//     orderBy?: keyof T;
//     orderDirection?: 'ASC' | 'DESC';
//   }
// }

// Redefine the `getByFields` method globally, fixing type mismatch issues
declare global {
  type FixedStore = Store & Omit<Store, "getByField" | "getByFields"> & {
    getByField<T extends Entity>(
      entity: string,
      field: string,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      value: any,
      options?: GetOptions<T>,
    ): Promise<T[]>;
  };

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const store: FixedStore;
}
