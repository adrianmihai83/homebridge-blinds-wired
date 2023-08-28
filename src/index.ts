/* Copyright(C) 2017-2020, Adrian Mihai (https://github.com/adrianmihai83). All rights reserved.
 *
 * index.ts: homebridge-blinds-wired plugin registration.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { API } from "homebridge";
import { blindsWiredPlatform } from "./blindsWired-platform";

// Register our platform with homebridge.
export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, blindsWiredPlatform);
};
