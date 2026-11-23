/* Copyright(C) 2017-2026, Adrian Mihai (https://github.com/adrianmihai83). All rights reserved.
 *
 * blindsWired-blind.ts: homebridge-blinds-wired window covering accessory.
 */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import { blindsWiredPlatform } from "./blindsWired-platform";
import { ResolvedBlindConfig } from "./blindsWired-types";
import { GpioManager, GpioValue } from "./gpio-manager";
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from "./settings";

type PinName = "upPin" | "downPin" | "stopPin";

export class Blind {
  public readonly accessory: PlatformAccessory;

  private readonly config: ResolvedBlindConfig;
  private readonly platform: blindsWiredPlatform;
  private readonly service: Service;
  private readonly gpioManager: GpioManager;
  private currentPosition: number;
  private targetPosition: number;
  private positionState: number;
  private gpioError?: Error;
  private isMoving = false;
  private moveTimer?: NodeJS.Timeout;
  private pulseTimer?: NodeJS.Timeout;

  constructor(platform: blindsWiredPlatform, config: ResolvedBlindConfig, gpioManager: GpioManager) {
    this.platform = platform;
    this.config = config;
    this.gpioManager = gpioManager;

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
      const selected = new Set(pinNames);
      this.gpioManager.setValues(this.gpioValues((name) => selected.has(name)));
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

    try {
      this.gpioManager.setValues(this.gpioValues(() => false));
    } catch (error) {
      this.gpioError = error instanceof Error ? error : new Error(String(error));
      this.platform.log.error("Unable to deactivate GPIO lines for %s: %s", this.config.name, this.gpioError.message);
    }
  }

  private ensureGpio(): void {
    if (this.gpioError) {
      throw this.gpioError;
    }
  }

  private gpioValues(isActive: (name: PinName) => boolean): GpioValue[] {
    const values: GpioValue[] = [
      { chip: this.config.gpioChip, offset: this.config.upPin, active: isActive("upPin") },
      { chip: this.config.gpioChip, offset: this.config.downPin, active: isActive("downPin") },
    ];
    if (this.config.stopPin !== 99) {
      values.push({ chip: this.config.gpioChip, offset: this.config.stopPin, active: isActive("stopPin") });
    }
    return values;
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
