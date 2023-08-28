/* Copyright(C) 2017-2020, Adrian Mihai (https://github.com/adrianmihai83). All rights reserved.
 *
 * blindsWired-blinds.ts: homebridge-blinds-wired window covering accessory.
 */
import {
  API,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  Logging,
  PlatformAccessory,
  Service
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { BlindConfig } from "./blindsWired-types";
import { blindsWiredPlatform } from "./blindsWired-platform";

import GPIO from "rpi-gpio";

interface blindWired {
  upPin: number;
  downPin: number;
  stopPin: number;
}

export class Blind {
  public accessory!: PlatformAccessory;
  private api: API;
  private readonly gpioPins: blindWired;
  private readonly config: BlindConfig;
  private currentPosition!: CharacteristicValue;
  private debug: (message: string, ...parameters: unknown[]) => void;
  private readonly transitionInterval!: number;
  public readonly activeLow!: boolean;
  public readonly pulseDuration!: number;
  public command!: string;
  private readonly hap: HAP;
  private isMoving: boolean;
  private readonly log: Logging;
  private moveIncrementInterval!: number;
  private moveTimer!: NodeJS.Timeout;
  private togglePin!: NodeJS.Timeout;
  private readonly name: string;
  private readonly platform: blindsWiredPlatform;
  private pollingTimer!: NodeJS.Timeout;
  private positionState!: CharacteristicValue;
  private targetPosition!: CharacteristicValue;

  constructor(platform: blindsWiredPlatform, blindConfig: BlindConfig) {
    this.api = platform.api;
    this.config = blindConfig;
    this.debug = platform.debug.bind(platform);
    this.hap = this.api.hap;
    this.isMoving = false;
    this.log = platform.log;
    this.platform = platform;

    // Name these blinds, primarily for logging purposes.
    this.name = blindConfig.name;

    // Get our commands to execute.
    this.gpioPins = { downPin: blindConfig.downPin, stopPin: blindConfig.stopPin, upPin: blindConfig.upPin };

    // No up or down gpioPins defined, we're done.
    if (
      !this.name ||
      !(this.gpioPins.upPin >= 0 && this.gpioPins.upPin <= 40) ||
      !(this.gpioPins.downPin >= 0 && this.gpioPins.downPin <= 40) ||
      !(this.gpioPins.stopPin >= 0 && this.gpioPins.stopPin <= 99)
    ) {
      return;
    }

    // Configure our delay between state changes.
    this.transitionInterval = blindConfig.transitionInterval;

    // Make sure we have a sane value for delay.
    if (this.transitionInterval < 0) {
      this.transitionInterval = 0;
    }

    // Configure our pulse duration.
    this.pulseDuration = blindConfig.pulseDuration;

    // Make sure we have a sane value for pulseDuration.
    if (this.pulseDuration < 0 || this.pulseDuration > 2000) {
      this.pulseDuration = 200;
    }

    // Configure our relay activation.
    this.activeLow = blindConfig.activeLow;

    // Make sure we have a sane value for activeLow (true or false).
    if (typeof this.activeLow !== "boolean") {
      this.activeLow = true;
    }

    // If we have a transition time set, calculate how many milliseconds are needed to increment the position by one, in milliseconds.
    this.moveIncrementInterval = this.transitionInterval ? this.transitionInterval * 10 : 100;

    // Initialize the blinds. This is a value between 0 - 100, in single steps.
    this.currentPosition = 0;
    this.positionState = this.api.hap.Characteristic.PositionState.STOPPED;
    this.targetPosition = 0;

    this.configureBlind();
    this.configureInfo();
    this.gpioInitialState(this.gpioPins.upPin, this.gpioPins.downPin, this.gpioPins.stopPin);
  }

  // Configure the blind accessory.
  private configureBlind(): boolean {
    const Characteristic = this.api.hap.Characteristic;

    // Generate this blind's unique identifier.
    const uuid = this.hap.uuid.generate("Blinds Wired." + this.name);

    // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
    let accessory;
    if ((accessory = this.platform.accessories.find((x) => x.UUID === uuid)) === undefined) {
      this.accessory = new this.api.platformAccessory(this.name, uuid);

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
      this.platform.accessories.push(this.accessory);
    }

    // We already had this accessory cached, let's use it.
    if (accessory) {
      this.accessory = accessory;
    }

    // Check to see if we already have a window covering service.
    let blindsService = this.accessory.getService(this.hap.Service.WindowCovering);

    // No window covering service found, let's add it.
    if (!blindsService) {
      // Now add the window covering service.
      blindsService = new this.hap.Service.WindowCovering(this.accessory.displayName);
      this.accessory.addService(blindsService);
    }

    // Initialize our state as stopped.
    blindsService.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

    // See if we have saved a state for our blind.
    this.currentPosition = -1;

    if ("blindPosition" in this.accessory.context) {
      this.currentPosition = this.accessory.context.blindPosition as CharacteristicValue;
    }

    // If we had an error getting the initial state, assume the blinds are closed.
    if (this.currentPosition === -1) {
      this.currentPosition = 0;
    }

    // Set the initial position for our blinds.
    this.targetPosition = this.currentPosition;
    blindsService.getCharacteristic(Characteristic.CurrentPosition).updateValue(this.currentPosition);
    blindsService.getCharacteristic(Characteristic.TargetPosition).updateValue(this.targetPosition);

    // Setup our event listeners.
    blindsService.getCharacteristic(Characteristic.CurrentPosition).on(CharacteristicEventTypes.GET, this.getCurrentPosition.bind(this));

    blindsService.getCharacteristic(Characteristic.PositionState).on(CharacteristicEventTypes.GET, this.getPositionState.bind(this));

    blindsService
      .getCharacteristic(Characteristic.TargetPosition)
      .on(CharacteristicEventTypes.GET, this.getTargetPosition.bind(this))
      .on(CharacteristicEventTypes.SET, this.setTargetPosition.bind(this));

    // Inform the user of our configuration.
    this.log.info(
      this.accessory.displayName +
        " configured: upPin " +
        this.gpioPins.upPin.toString() +
        ", downPin " +
        this.gpioPins.downPin.toString() +
        ", stopPin " +
        this.gpioPins.stopPin.toString() +
        ", pulse duration " +
        this.pulseDuration.toString() +
        "ms, transition time " +
        this.transitionInterval.toString() +
        "s, activeLow " +
        this.activeLow.toString()
    );

    return true;
  }

  // Configure the blind information for HomeKit.
  private configureInfo(): boolean {
    // Update the manufacturer information for this blind.
    if (this.config.manufacturer) {
      this.accessory
        .getService(this.hap.Service.AccessoryInformation)
        ?.getCharacteristic(this.hap.Characteristic.Manufacturer)
        .updateValue(this.config.manufacturer);
    }

    // Update the model information for this blind.
    if (this.config.model) {
      this.accessory
        .getService(this.hap.Service.AccessoryInformation)
        ?.getCharacteristic(this.hap.Characteristic.Model)
        .updateValue(this.config.model);
    }

    // Update the serial number for this blind.
    if (this.config.serial) {
      this.accessory
        .getService(this.hap.Service.AccessoryInformation)
        ?.getCharacteristic(this.hap.Characteristic.SerialNumber)
        .updateValue(this.config.serial);
    }

    return true;
  }

  private gpioInitialState(upPin: number, downPin: number, stopPin: number): void {
    GPIO.MODE_BCM;
    GPIO.setup(upPin, this.activeLow ? GPIO.DIR_HIGH : GPIO.DIR_LOW);
    GPIO.setup(downPin, this.activeLow ? GPIO.DIR_HIGH : GPIO.DIR_LOW);
    if (stopPin !== 99) {
      GPIO.setup(stopPin, this.activeLow ? GPIO.DIR_HIGH : GPIO.DIR_LOW);
    }
  }

  // Configure a stop switch.
  private configureStop(): boolean {
    // Clear out any previous switch service.
    const switchService = this.accessory.getService(this.hap.Service.Switch);

    if (switchService) {
      this.accessory.removeService(switchService);
    }

    return true;
  }

  // User-friendly name for a given position.
  private getPositionName(position: CharacteristicValue): string {
    switch (position) {
      case 0:
        return "closed";
        break;

      case 100:
        return "open";
        break;

      default:
        return position.toString() + "%";
        break;
    }
  }

  // Get the current window covering state.
  private getPositionState(callback: CharacteristicGetCallback): void {
    callback(undefined, this.positionState);
  }

  // Get the current window covering state.
  private getCurrentPosition(callback: CharacteristicGetCallback): void {
    callback(undefined, this.currentPosition);
  }

  // Get the target window covering state.
  private getTargetPosition(callback: CharacteristicGetCallback): void {
    callback(undefined, this.targetPosition);
  }

  // Set the target window covering state and execute the action.
  private setTargetPosition(value: CharacteristicValue, callback: CharacteristicSetCallback): void {
    const Characteristic = this.hap.Characteristic;

    // Grab the blinds service.
    const blindsService = this.accessory.getService(this.hap.Service.WindowCovering);

    if (!blindsService) {
      callback(Error("Error finding the blinds service."));
      return;
    }

    // We're already where we want to be, do nothing.
    if (value === this.currentPosition) {
      this.log("We're already where we want to be, do nothing");
      this.targetPosition = value;
      this.positionState = Characteristic.PositionState.STOPPED;

      blindsService.getCharacteristic(Characteristic.TargetPosition).updateValue(this.targetPosition);
      blindsService.getCharacteristic(Characteristic.CurrentPosition).updateValue(this.currentPosition);
      blindsService.getCharacteristic(Characteristic.PositionState).updateValue(this.positionState);

      callback(null);
      return;
    }

    // We're moving. We don't want any status refreshes until we complete the move.
    this.isMoving = true;

    // Figure out our move dynamics.
    const moveUp = value > this.currentPosition;
    this.targetPosition = value;
    this.positionState = moveUp ? Characteristic.PositionState.INCREASING : Characteristic.PositionState.DECREASING;

    // Tell HomeKit we're on the move.
    blindsService.getCharacteristic(Characteristic.PositionState).updateValue(this.positionState);

    this.log.info(
      "%s: Moving %s from %s to %s.",
      this.accessory.displayName,
      moveUp ? "up" : "down",
      this.getPositionName(this.currentPosition),
      this.getPositionName(this.targetPosition)
    );

    // Execute the move command.
    this.command = "MOVE";
    let newPosition = this.execCommand(this.command, moveUp ? this.gpioPins.upPin : this.gpioPins.downPin, Number(this.targetPosition));

    // Something went wrong...cleanup and stop.
    if (newPosition === -1) {
      clearTimeout(this.moveTimer);
      this.positionState = Characteristic.PositionState.STOPPED;
      blindsService.getCharacteristic(Characteristic.PositionState).updateValue(this.positionState);
      callback(Error("Error executing the move command."));
      this.isMoving = false;
      return;
    }

    // Special case - if we don't have a script that returns a position as output, we infer the
    // answer based on whether we are opening or closing, and assume we have opened or closed completely.
    if (!newPosition && moveUp) {
      newPosition = 100;
    }

    // Execute the move and we're done.
    this.moveBlind(blindsService, newPosition, moveUp ? 1 : -1);

    callback(null);
  }

  // Emulate a sleep function.
  private sleep(ms: number): Promise<NodeJS.Timeout> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Move a blind in HomeKit.
  private moveBlind(blindsService: Service, finalPosition: CharacteristicValue, increment: CharacteristicValue): void {
    // Clear out the previous delay timer, if one is configured.
    clearTimeout(this.moveTimer);

    // Set a timer to simulate an actual delay in completing the action to give us that interactive feeling.
    this.moveTimer = setTimeout(() => {
      // Increment our position.
      this.accessory.context.blindPosition = (this.currentPosition as number) += increment as number;

      // If we exceed our bounds or we're at our final position, we're done.
      if (Number(this.currentPosition) <= 0 || Number(this.currentPosition) >= 100 || this.currentPosition === finalPosition) {
        // Our final position is something other than completely open or completely closed.
        if (Number(this.currentPosition) > 0 && Number(this.currentPosition) < 100) {
          // Trigger the stop script, if we have one configured.
          const newPosition = this.stopBlind();
          if (newPosition !== -1) {
            finalPosition = newPosition;
          }
        }

        // Update the final values and tell HomeKit we're done.
        this.accessory.context.blindPosition = this.targetPosition = this.currentPosition = finalPosition;
        this.positionState = this.hap.Characteristic.PositionState.STOPPED;

        blindsService.getCharacteristic(this.hap.Characteristic.TargetPosition).updateValue(this.targetPosition);
        blindsService.getCharacteristic(this.hap.Characteristic.CurrentPosition).updateValue(this.currentPosition);
        blindsService.getCharacteristic(this.hap.Characteristic.PositionState).updateValue(this.positionState);

        // We're done moving.
        this.isMoving = false;
        this.log(this.accessory.displayName + " has stopped at " + finalPosition.toString() + "%");
        return;
      }

      // We're still moving. Update our current position, and let's keep moving.
      blindsService.getCharacteristic(this.hap.Characteristic.CurrentPosition).updateValue(this.currentPosition);
      this.moveBlind(blindsService, finalPosition, increment);
    }, this.moveIncrementInterval);
  }

  // Stop a blind in HomeKit.
  private stopBlind(): number {
    // Only execute if we've configured a stop pin.
    if (!(this.gpioPins.stopPin >= 0 && this.gpioPins.stopPin <= 99)) {
      return -1;
    }

    // Execute and return.
    this.command = "STOP";
    return this.execCommand(this.command, this.gpioPins.stopPin, Number(this.currentPosition));
  }

  // Execute a command, with error handling.
  private execCommand(command: string, pin: number, position: number): number {
    clearTimeout(this.togglePin);
    //Check if pin=99; stop pulsing both pinUp and pinDown at the same time, Somfy DCT
    if (this.command === "STOP" && pin === 99) {
      this.log(
        "Executed command " +
          command +
          ", pulsing pins " +
          this.gpioPins.upPin.toString() +
          " and " +
          this.gpioPins.downPin.toString() +
          ", pulseDuration: " +
          this.pulseDuration.toString() +
          "ms, setting position to " +
          position.toString() +
          "%"
      );
      //toggle pins
      GPIO.write(this.gpioPins.upPin, this.activeLow ? false : true);
      GPIO.write(this.gpioPins.downPin, this.activeLow ? false : true);
      //after pulseDuration, toggle back pins
      this.togglePin = setTimeout(() => {
        GPIO.write(this.gpioPins.upPin, this.activeLow ? true : false);
        GPIO.write(this.gpioPins.downPin, this.activeLow ? true : false);
      }, this.pulseDuration);
      // up or down command
    } else {
      this.log(
        "Executed command " +
          command +
          ", pulsing pin " +
          pin.toString() +
          ", pulseDuration: " +
          this.pulseDuration.toString() +
          "ms, setting position to " +
          position.toString() +
          "%"
      );
      //GPIO.write(pin, this.activeLow ? false : true);
      //this.togglePin = setTimeout(() => {
      //  GPIO.write(pin, this.activeLow ? true : false);
      //}, this.pulseDuration);
    }
    try {
      // Parse the return value.
      //const returnValue = parseInt(stdout);
      const returnValue = 0;

      // Validate the return value.
      if (isNaN(returnValue) || returnValue < 0 || returnValue > 100) {
        this.log.error("Invalid value returned when toggling %s: %s. A numeric value between 0 and 99 is expected.", pin.toString(), returnValue);
        return -1;
      }

      // Return the value.
      return returnValue;
    } catch (error) {
      if (!(error instanceof Error)) {
        this.log.error("Unknown error received while attempting to toggle pin %s: %s.", command, error);
        return -1;
      }

      this.log.error("Error executing the command: %s.", error.message);
      return -1;
    }
  }
}
