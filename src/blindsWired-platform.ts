/* Copyright(C) 2017-2026, Adrian Mihai (https://github.com/adrianmihai83). All rights reserved.
 *
 * blindsWired-platform.ts: homebridge-blinds-wired platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import util from "util";

import { Blind } from "./blindsWired-blind";
import { BlindConfig, ResolvedBlindConfig } from "./blindsWired-types";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";

const DEFAULT_STOP_PIN = 99;
const DEFAULT_GPIO_CHIP = 0;
const DEFAULT_PULSE_DURATION = 200;
const DEFAULT_TRANSITION_INTERVAL = 10;

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function resolveBlindConfig(config: BlindConfig): { config?: ResolvedBlindConfig; errors: string[] } {
  const resolved: ResolvedBlindConfig = {
    name: typeof config.name === "string" ? config.name.trim() : "",
    upPin: config.upPin,
    downPin: config.downPin,
    stopPin: config.stopPin ?? DEFAULT_STOP_PIN,
    gpioChip: config.gpioChip ?? DEFAULT_GPIO_CHIP,
    pulseDuration: config.pulseDuration ?? DEFAULT_PULSE_DURATION,
    activeLow: config.activeLow ?? true,
    transitionInterval: config.transitionInterval ?? DEFAULT_TRANSITION_INTERVAL,
    manufacturer: config.manufacturer,
    model: config.model,
    serial: config.serial,
  };
  const errors: string[] = [];

  if (!resolved.name) {
    errors.push("name must be a non-empty string");
  }
  if (!isIntegerInRange(resolved.upPin, 0, 99)) {
    errors.push("upPin must be an integer between 0 and 99");
  }
  if (!isIntegerInRange(resolved.downPin, 0, 99)) {
    errors.push("downPin must be an integer between 0 and 99");
  }
  if (!isIntegerInRange(resolved.stopPin, 0, 99)) {
    errors.push("stopPin must be an integer between 0 and 99");
  }
  if (!isIntegerInRange(resolved.gpioChip, 0, 9)) {
    errors.push("gpioChip must be an integer between 0 and 9");
  }
  if (!isIntegerInRange(resolved.pulseDuration, 0, 2000)) {
    errors.push("pulseDuration must be an integer between 0 and 2000 milliseconds");
  }
  if (typeof resolved.activeLow !== "boolean") {
    errors.push("activeLow must be true or false");
  }
  if (typeof resolved.transitionInterval !== "number"
    || !Number.isFinite(resolved.transitionInterval)
    || resolved.transitionInterval < 0
    || resolved.transitionInterval > 120) {
    errors.push("transitionInterval must be a number between 0 and 120 seconds");
  }
  if (resolved.upPin === resolved.downPin) {
    errors.push("upPin and downPin must use different GPIO lines");
  }
  if (resolved.stopPin !== DEFAULT_STOP_PIN
    && (resolved.stopPin === resolved.upPin || resolved.stopPin === resolved.downPin)) {
    errors.push("stopPin must use a different GPIO line, or 99 for Somfy DCT");
  }

  return errors.length > 0 ? { errors } : { config: resolved, errors };
}

export class blindsWiredPlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];
  public readonly api: API;
  public readonly log: Logging;
  public debugMode = false;

  private readonly blinds: Blind[] = [];
  private readonly configuredBlinds: BlindConfig[];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;
    this.log = log;
    this.debugMode = config?.debug === true;
    this.configuredBlinds = Array.isArray(config?.blinds) ? config.blinds as BlindConfig[] : [];

    if (this.debugMode) {
      this.debug("Debug logging enabled.");
    }
    if (this.configuredBlinds.length === 0) {
      this.log.error("No blinds have been configured.");
      return;
    }

    api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.configureBlinds());
    api.on(APIEvent.SHUTDOWN, () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  debug(message: string, ...parameters: unknown[]): void {
    if (this.debugMode) {
      this.log.debug(util.format(message, ...parameters));
    }
  }

  private configureBlinds(): void {
    const configuredNames = new Set<string>();

    for (const blindConfig of this.configuredBlinds) {
      const result = resolveBlindConfig(blindConfig);
      const name = typeof blindConfig.name === "string" && blindConfig.name.trim() ? blindConfig.name.trim() : "unnamed blind";

      if (!result.config) {
        this.log.error("Invalid configuration for %s: %s.", name, result.errors.join("; "));
        continue;
      }
      if (configuredNames.has(result.config.name)) {
        this.log.error("Blind names must be unique; ignoring duplicate name: %s.", result.config.name);
        continue;
      }

      configuredNames.add(result.config.name);
      this.blinds.push(new Blind(this, result.config));
    }

    for (const accessory of this.accessories) {
      if (this.blinds.some((blind) => blind.accessory.UUID === accessory.UUID)) {
        continue;
      }

      this.log.info("Removing blind from HomeKit: %s.", accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  private shutdown(): void {
    for (const blind of this.blinds) {
      blind.shutdown();
    }
  }
}

export const configuration = {
  resolveBlindConfig,
};
