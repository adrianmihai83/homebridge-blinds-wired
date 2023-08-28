/* Copyright(C) 2017-2020, Adrian Mihai (https://github.com/adrianmihai83). All rights reserved.
 *
 * blindsWired-platform.ts: homebridge-blinds-wired platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { BlindConfig, blindsWiredConfig } from "./blindsWired-types";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { Blind } from "./blindsWired-blind";
import util from "util";

export class blindsWiredPlatform implements DynamicPlatformPlugin {
  public accessories: PlatformAccessory[] = [];
  public readonly api: API;
  private readonly blinds: Blind[] = [];
  private config!: blindsWiredConfig;
  public debugMode = false;
  public readonly log: Logging;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;
    this.log = log;

    // No configuration found - we won't start.
    if (!config) {
      return;
    }

    // If we don't have any blinds configured, we're done here.
    if (!config.blinds) {
      this.log.error("No blinds have been configured.");
      return;
    }

    // Force this to BlindConfig.
    this.config = {
      blinds: config.blinds as BlindConfig[]
    };

    // Capture configuration parameters.
    if (config.debug) {
      this.debugMode = config.debug === true;
      this.debug("Debug logging on. Expect a lot of data.");
    }

    // Avoid a prospective race condition by waiting to configure our blinds until Homebridge is done
    // loading all the cached accessories it knows about, and calling configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.configureBlinds.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup.
  configureAccessory(accessory: PlatformAccessory): void {
    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Configure our blinds.
  private configureBlinds(): void {
    // Loop through each configured blind and instantiate it.
    for (const blindsConfig of this.config.blinds) {
      // No name or up or down or stop pins defined, we're done.
      if (
        !blindsConfig.name ||
        !(blindsConfig.upPin >= 0 && blindsConfig.upPin <= 40) ||
        !(blindsConfig.downPin >= 0 && blindsConfig.downPin <= 40) ||
        !(blindsConfig.stopPin >= 0 && blindsConfig.stopPin <= 99) ||
        !(blindsConfig.pulseDuration >= 0 && blindsConfig.pulseDuration <= 2000)
      ) {
        this.log.error("Name, upPin, downPin, stopPin and pulseDuration are required configuration parameters.");
        continue;
      }

      this.blinds.push(new Blind(this, blindsConfig));
    }

    // Remove any blinds that are no longer configured.
    for (const accessory of this.accessories) {
      // We've configured this blind already, let's keep going.
      if (this.blinds.some((x) => x.accessory.UUID === accessory.UUID)) {
        continue;
      }

      // If we have a blind that we don't have a configuration for, remove it and inform the user.
      this.log.info("Removing blind from HomeKit: %s.", accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  // Utility for debug logging.
  debug(message: string, ...parameters: unknown[]): void {
    if (this.debugMode) {
      this.log.error(util.format(message, ...parameters));
    }
  }
}
