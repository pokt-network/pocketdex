/* eslint-disable @typescript-eslint/explicit-module-boundary-types,@typescript-eslint/no-explicit-any */

// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

/* class decorator */

import { performance } from "perf_hooks";

function isPromise(e: any): boolean {
  return !!e && typeof e.then === "function";
}

function printCost(start: number, end: number, target: string, method: string | symbol): void {
  logger.info(`[${target}] ${method.toString()} - ${end - start} ms`);
}

// noinspection JSUnusedGlobalSymbols
export function profiler(): MethodDecorator {
  return (target, name: string | symbol, descriptor: PropertyDescriptor): void => {
    if (!!descriptor && typeof descriptor.value === "function") {
      const orig = descriptor.value;
      // tslint:disable no-function-expression no-invalid-this
      descriptor.value = function(...args: any[]): any {
        const start = performance.now();
        const res = orig.bind(this)(...args);
        if (isPromise(res)) {
          res.then(
            (_: any) => {
              printCost(start, performance.now(), target.constructor.name, name);
              return _;
            },
            (err: any) => {
              printCost(start, performance.now(), target.constructor.name, name);
              throw err;
            },
          );
        } else {
          printCost(start, performance.now(), target.constructor.name, name);
        }
        return res;
      };
    }
  };
}

type AnyFn = (...args: any[]) => any;

export const profilerWrap =
  <T extends AnyFn>(method: T, target: any, name: string) =>
    (...args: Parameters<T>): ReturnType<T> => {
      const start = performance.now();
      const res = method(...args);
      if (isPromise(res)) {
        res.then(
          (_: any) => {
            printCost(start, performance.now(), target, name);
            return _;
          },
          (err: any) => {
            printCost(start, performance.now(), target, name);
            throw err;
          },
        );
      } else {
        printCost(start, performance.now(), target, name);
      }
      return res;
    };
