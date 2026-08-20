
// This file is a workaround for a bug in the Dexie types for Next.js.
// It should be removed once the issue is fixed in the library.
// See: https://github.com/dexie/Dexie.js/issues/1825
declare module 'dexie-react-hooks' {
  import { Dexie, Table } from 'dexie';

  export function useLiveQuery<T>(
    querier: () => T | Promise<T>,
    deps?: any[],
    defaultResult?: T
  ): T;
}
