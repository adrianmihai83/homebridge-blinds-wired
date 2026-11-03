/* Copyright(C) 2017-2026, Adrian Mihai (https://github.com/adrianmihai83). All rights reserved.
 *
 * blindsWired-blind.ts: homebridge-blinds-wired window covering accessory.
 */
import type { Chip, Line } from "node-libgpiod";
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import { blindsWiredPlatform } from "./blindsWired-platform";
import { ResolvedBlindConfig } from "./blindsWired-types";
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from "./settings";

interface BlindLines {
  upPin: Line;
  downPin: Line;
  stopPin?: Line;
}

type PinName = keyof BlindLines;

export class Blind {
  public readonly accessory: PlatformAccessory;

  private readonly config: ResolvedBlindConfig;
  private readonly platform: blindsWiredPlatform;
  private readonly service: Service;
  private currentPosition: number;
  private targetPosition: number;
  private positionState: number;
  private gpioChip?: Chip;
  private gpioLines: Partial<BlindLines> = {};
  private gpioError?: Error;
  private isMoving = false;
  private moveTimer?: NodeJS.Timeout;
  private pulseTimer?: NodeJS.Timeout;

  constructor(platform: blindsWiredPlatform, config: ResolvedBlindConfig) {
    this.platform = platform;
    this.config = config;

    const uuid = platform.api.hap.uuid.generate("Blinds Wired." + config.name);
    const cachedAccessory = platform.accessories.find((candidate) => candidate.UUID === uuid);
    this.accessory = cachedAccessory ?? new platform.api.platformAccessory(config.name, uuid);

    if (!cachedAccessory) {
      platform.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
      platform.accessories.push(this.accessory);
    }

    this.service = this.accessory.getService(platform.api.hap.Service.WindowCovering)
      ?? this.accessory.addService(platform.api.hap.Service.WindowCovering, config.name);

    const cachedPosition = Number(this.accessory.context.blindPosition);
    this.currentPosition = Number.isFinite(cachedPosition) && cachedPosition >= 0 && cachedPosition <= 100
      ? Math.round(cachedPosition)
      : 0;
    this.targetPosition = this.currentPosition;
    this.positionState = platform.api.hap.Characteristic.PositionState.STOPPED;

    this.configureInformation();
    this.configureCharacteristics();
    this.initializeGpio();
    this.updateAccessoryContext();

    platform.log.info(
      "%s configured: upPin %d, downPin %d, stopPin %d, gpioChip %d, pulse %dms, transition %ss, activeLow %s.",
      config.name,
      config.upPin,
      config.downPin,
      config.stopPin,
      config.gpioChip,
      config.pulseDuration,
      config.transitionInterval,
      config.activeLow,
    );
  }

  shutdown(): void {
    this.isMoving = false;
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = undefined;
    }
    this.finishPulse();

    for (const [name, line] of Object.entries(this.gpioLines)) {
      if (!line) {
        continue;
      }
      try {
        line.setValue(this.inactiveValue());
      } catch (error) {
        this.platform.log.warn("Unable to set %s %s inactive during shutdown: %s", this.config.name, name, this.errorMessage(error));
      }
      try {
        line.release();
      } catch (error) {
        this.platform.log.warn("Unable to release %s %s during shutdown: %s", this.config.name, name, this.errorMessage(error));
      }
    }

    this.gpioLines = {};
    this.gpioChip = undefined;
  }

  private configureCharacteristics(): void {
    const Characteristic = this.platform.api.hap.Characteristic;

    this.service.setCharacteristic(Characteristic.PositionState, this.positionState);
    this.service.setCharacteristic(Characteristic.CurrentPosition, this.currentPosition);
    this.service.setCharacteristic(Characteristic.TargetPosition, this.targetPosition);

    this.service.getCharacteristic(Characteristic.CurrentPosition).onGet(() => this.currentPosition);
    this.service.getCharacteristic(Characteristic.PositionState).onGet(() => this.positionState);
    this.service.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.targetPosition)
      .onSet((value) => this.setTargetPosition(value));
  }

  private configureInformation(): void {
    const { Characteristic, Service: HapService } = this.platform.api.hap;
    const information = this.accessory.getService(HapService.AccessoryInformation);

    information
      ?.setCharacteristic(Characteristic.Manufacturer, this.config.manufacturer || "adrianmihai83")
      .setCharacteristic(Characteristic.Model, this.config.model || "Raspberry Pi GPIO Wired Blind")
      .setCharacteristic(
        Characteristic.SerialNumber,
        this.config.serial || `${this.config.gpioChip}-${this.config.upPin}-${this.config.downPin}`,
      )
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);
  }

  private initializeGpio(): void {
    try {
      // Loading the native module here allows Homebridge to inspect or disable
      // the plugin on machines that do not provide Raspberry Pi GPIO.
      const Gpio = require("node-libgpiod") as typeof import("node-libgpiod");
      this.gpioChip = new Gpio.Chip(this.config.gpioChip);
      this.gpioLines.upPin = this.requestLine(Gpio, this.config.upPin);
      this.gpioLines.downPin = this.requestLine(Gpio, this.config.downPin);
      if (this.config.stopPin !== 99) {
        this.gpioLines.stopPin = this.requestLine(Gpio, this.config.stopPin);
      }
      this.gpioError = undefined;
    } catch (error) {
      const gpioError = error instanceof Error ? error : new Error(String(error));
      this.shutdown();
      this.gpioError = gpioError;
      this.platform.log.error("Unable to initialise GPIO for %s: %s", this.config.name, this.gpioError.message);
    }
  }

  private requestLine(Gpio: typeof import("node-libgpiod"), pin: number): Line {
    if (!this.gpioChip) {
      throw new Error("GPIO chip is not available");
    }
    const line = new Gpio.Line(this.gpioChip, pin);
    // Request the line with its inactive value from the first output state.
    // This avoids a short active-low relay pulse during Homebridge startup.
    try {
      line.requestOutputMode(PLUGIN_NAME, this.inactiveValue());
    } catch (error) {
      try {
        line.release();
      } catch {
        // Preserve the original request error.
      }
      throw error;
    }
    return line;
  }

  private setTargetPosition(value: CharacteristicValue): void {
    const requestedPosition = Number(value);
    if (!Number.isFinite(requestedPosition) || requestedPosition < 0 || requestedPosition > 100) {
      throw new Error("Target position must be between 0 and 100");
    }

    const target = Math.round(requestedPosition);
    if (target === this.currentPosition) {
      if (this.isMoving) {
        this.pulse(this.config.stopPin === 99 ? ["upPin", "downPin"] : ["stopPin"]);
      }
      this.targetPosition = target;
      this.stopPositionUpdates();
      return;
    }

    this.ensureGpio();
    const moveUp = target > this.currentPosition;
    this.targetPosition = target;
    this.positionState = moveUp
      ? this.platform.api.hap.Characteristic.PositionState.INCREASING
      : this.platform.api.hap.Characteristic.PositionState.DECREASING;
    this.isMoving = true;
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.TargetPosition, this.targetPosition);
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.PositionState, this.positionState);

    this.platform.log.info(
      "%s: Moving %s from %s to %s.",
      this.config.name,
      moveUp ? "up/open" : "down/close",
      this.positionName(this.currentPosition),
      this.positionName(this.targetPosition),
    );

    try {
      this.pulse(moveUp ? ["upPin"] : ["downPin"]);
      this.schedulePositionUpdate(moveUp ? 1 : -1);
    } catch (error) {
      this.targetPosition = this.currentPosition;
      this.stopPositionUpdates();
      throw error;
    }
  }

  private schedulePositionUpdate(increment: 1 | -1): void {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
    }

    const millisecondsPerPercent = this.config.transitionInterval > 0
      ? this.config.transitionInterval * 10
      : 0;
    this.moveTimer = setTimeout(() => {
      this.currentPosition = Math.max(0, Math.min(100, this.currentPosition + increment));
      this.accessory.context.blindPosition = this.currentPosition;
      this.service.updateCharacteristic(this.platform.api.hap.Characteristic.CurrentPosition, this.currentPosition);

      if (this.currentPosition === this.targetPosition || this.currentPosition === 0 || this.currentPosition === 100) {
        if (this.currentPosition > 0 && this.currentPosition < 100) {
          try {
            this.pulse(this.config.stopPin === 99 ? ["upPin", "downPin"] : ["stopPin"]);
          } catch (error) {
            this.platform.log.error("Unable to stop %s: %s", this.config.name, this.errorMessage(error));
          }
        }
        this.targetPosition = this.currentPosition;
        this.stopPositionUpdates();
        this.platform.log.info("%s has stopped at %d%%.", this.config.name, this.currentPosition);
        return;
      }

      this.schedulePositionUpdate(increment);
    }, millisecondsPerPercent);
    this.moveTimer.unref?.();
  }

  private stopPositionUpdates(): void {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = undefined;
    }
    this.isMoving = false;
    this.positionState = this.platform.api.hap.Characteristic.PositionState.STOPPED;
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.TargetPosition, this.targetPosition);
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.CurrentPosition, this.currentPosition);
    this.service.updateCharacteristic(this.platform.api.hap.Characteristic.PositionState, this.positionState);
    this.updateAccessoryContext();
  }

  private pulse(pinNames: PinName[]): void {
    this.ensureGpio();
    this.finishPulse();

    try {
      for (const pinName of pinNames) {
        const line = this.gpioLines[pinName];
        if (!line) {
          throw new Error(`GPIO line ${pinName} is not configured`);
        }
        line.setValue(this.activeValue());
      }
    } catch (error) {
      this.finishPulse();
      throw error;
    }

    this.pulseTimer = setTimeout(() => this.finishPulse(), this.config.pulseDuration);
    this.pulseTimer.unref?.();
  }

  private finishPulse(): void {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = undefined;
    }

    for (const line of Object.values(this.gpioLines)) {
      if (!line) {
        continue;
      }
      try {
        line.setValue(this.inactiveValue());
      } catch (error) {
        this.gpioError = error instanceof Error ? error : new Error(String(error));
        this.platform.log.error("Unable to deactivate a GPIO line for %s: %s", this.config.name, this.gpioError.message);
      }
    }
  }

  private ensureGpio(): void {
    if (this.gpioError) {
      throw this.gpioError;
    }
    if (!this.gpioLines.upPin || !this.gpioLines.downPin) {
      throw new Error("GPIO lines are not available");
    }
  }

  private updateAccessoryContext(): void {
    this.accessory.context.blindPosition = this.currentPosition;
    this.accessory.context.device = {
      name: this.config.name,
      upPin: this.config.upPin,
      downPin: this.config.downPin,
      stopPin: this.config.stopPin,
      gpioChip: this.config.gpioChip,
      pulseDuration: this.config.pulseDuration,
      activeLow: this.config.activeLow,
      transitionInterval: this.config.transitionInterval,
    };
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private activeValue(): number {
    return this.config.activeLow ? 0 : 1;
  }

  private inactiveValue(): number {
    return this.config.activeLow ? 1 : 0;
  }

  private positionName(position: number): string {
    if (position === 0) {
      return "closed";
    }
    if (position === 100) {
      return "open";
    }
    return `${position}%`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
