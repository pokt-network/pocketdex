import type { Entity, GetOptions, Store } from "@subql/types-core/dist/store";

declare global {
  type FixedStore = Omit<Store, 'getByField'> & {
    getByField<T extends Entity>(entity: string, field: string, value: any, options?: GetOptions<T>): Promise<T[]>;
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const store: FixedStore;
}
