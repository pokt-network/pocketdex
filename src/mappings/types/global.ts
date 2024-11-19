import type { Entity, GetOptions, Store } from "@subql/types-core/dist/store";

// This declaration resolves a type mismatch with the `store.getByField` method
// in the generated files. The original method from the library does not
// support a generic type, which causes TypeScript errors when used with generics.
// To fix this, we redefine the `getByField` method to explicitly accept a generic type.
declare global {
  type FixedStore = Omit<Store, 'getByField'> & {
    getByField<T extends Entity>(entity: string, field: string, value: any, options?: GetOptions<T>): Promise<T[]>;
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const store: FixedStore;
}
