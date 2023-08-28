/* Copyright(C) 2020, Adrian Mihai (https://github.com/adrianmihai83). All rights reserved.
 *
 * blindsWired-types.ts: Type definitions for homebridge-blinds-wired.
 */

export interface blindsWiredConfigInterface {
  blinds: BlindConfig[];
}

// Plugin configuration options.
export interface BlindConfigInterface {
  name: string;
  upPin: number;
  downPin: number;
  stopPin: number;
  pulseDuration: number;
  activeLow: boolean;
  transitionInterval: number;
  manufacturer: string;
  model: string;
  serial: string;
}

// This type declaration make all properties optional recursively including nested objects. This should
// only be used on JSON objects only. Otherwise...you're going to end up with class methods marked as
// optional as well. Credit for this belongs to: https://github.com/joonhocho/tsdef. #Grateful
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer I> ? Array<DeepPartial<I>> : DeepPartial<T[P]>;
};

// We use types instead of interfaces here because we can more easily set the entire thing as readonly.
// Unfortunately, interfaces can't be quickly set as readonly in Typescript without marking each and
// every property as readonly along the way.
export type blindsWiredConfig = Readonly<blindsWiredConfigInterface>;
export type BlindConfig = Readonly<BlindConfigInterface>;
