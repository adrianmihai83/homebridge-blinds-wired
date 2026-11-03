"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");

const gpioOperations = [];
let failGpioRequest = false;

class FakeChip {
  constructor(number) {
    this.number = number;
    gpioOperations.push(["chip", number]);
  }
}

class FakeLine {
  constructor(chip, pin) {
    this.chip = chip;
    this.pin = pin;
    gpioOperations.push(["line", chip.number, pin]);
  }

  requestOutputMode(consumer, initialValue) {
    if (failGpioRequest) {
      throw new Error("GPIO unavailable");
    }
    gpioOperations.push(["requestOutputMode", this.pin, consumer, initialValue]);
  }

  setValue(value) {
    gpioOperations.push(["setValue", this.pin, value]);
  }

  release() {
    gpioOperations.push(["release", this.pin]);
  }
}

const originalLoad = Module._load;
Module._load = function mockNativeGpio(request, parent, isMain) {
  if (request === "node-libgpiod") {
    return { Chip: FakeChip, Line: FakeLine };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const initialisePlugin = require("../dist/index.js");
const { configuration } = require("../dist/blindsWired-platform.js");

function characteristic(name, values = {}) {
  return Object.assign({ name }, values);
}

const Characteristic = {
  CurrentPosition: characteristic("CurrentPosition"),
  TargetPosition: characteristic("TargetPosition"),
  PositionState: characteristic("PositionState", { DECREASING: 0, INCREASING: 1, STOPPED: 2 }),
  Manufacturer: characteristic("Manufacturer"),
  Model: characteristic("Model"),
  SerialNumber: characteristic("SerialNumber"),
  FirmwareRevision: characteristic("FirmwareRevision"),
};

class FakeCharacteristic {
  constructor() {
    this.value = undefined;
    this.getter = undefined;
    this.setter = undefined;
  }

  onGet(handler) {
    this.getter = handler;
    return this;
  }

  onSet(handler) {
    this.setter = handler;
    return this;
  }
}

class FakeService {
  constructor(name = "") {
    this.displayName = name;
    this.characteristics = new Map();
  }

  getCharacteristic(item) {
    if (!this.characteristics.has(item)) {
      this.characteristics.set(item, new FakeCharacteristic());
    }
    return this.characteristics.get(item);
  }

  updateCharacteristic(item, value) {
    this.getCharacteristic(item).value = value;
    return this;
  }

  setCharacteristic(item, value) {
    return this.updateCharacteristic(item, value);
  }
}

class WindowCovering extends FakeService {}
class AccessoryInformation extends FakeService {}
const Service = { WindowCovering, AccessoryInformation };

class FakePlatformAccessory {
  constructor(name, uuid) {
    this.displayName = name;
    this.UUID = uuid;
    this.context = {};
    this.services = [new AccessoryInformation()];
  }

  getService(ServiceType) {
    return this.services.find((service) => service instanceof ServiceType);
  }

  addService(ServiceType, name) {
    const service = new ServiceType(name);
    this.services.push(service);
    return service;
  }
}

function createApi() {
  const api = new EventEmitter();
  api.hap = {
    Service,
    Characteristic,
    uuid: { generate: (value) => `uuid:${value}` },
  };
  api.platformAccessory = FakePlatformAccessory;
  api.registered = [];
  api.unregistered = [];
  api.updated = [];
  api.registerPlatform = (plugin, alias, Constructor) => {
    api.PlatformConstructor = Constructor;
    api.platformRegistration = { plugin, alias };
  };
  api.registerPlatformAccessories = (plugin, alias, accessories) => api.registered.push(...accessories);
  api.unregisterPlatformAccessories = (plugin, alias, accessories) => api.unregistered.push(...accessories);
  api.updatePlatformAccessories = (accessories) => api.updated.push(...accessories);
  return api;
}

function createLog() {
  const messages = [];
  const log = (message) => messages.push(["log", message]);
  for (const level of ["debug", "info", "warn", "error"]) {
    log[level] = (...args) => messages.push([level, ...args]);
  }
  log.messages = messages;
  return log;
}

const validPlatformConfig = {
  platform: "Blinds Wired",
  blinds: [{
    name: "Living Room",
    upPin: 17,
    downPin: 27,
    stopPin: 99,
    gpioChip: 0,
    pulseDuration: 100,
    activeLow: true,
    transitionInterval: 0,
  }],
};

function startPlatform(config = validPlatformConfig) {
  const api = createApi();
  initialisePlugin(api);
  const log = createLog();
  const platform = new api.PlatformConstructor(log, config, api);
  api.emit("didFinishLaunching");
  return { api, log, platform };
}

test.beforeEach(() => {
  gpioOperations.length = 0;
  failGpioRequest = false;
});

test("registers the Homebridge 2 dynamic platform", () => {
  const api = createApi();
  initialisePlugin(api);

  assert.deepEqual(api.platformRegistration, {
    plugin: "homebridge-blinds-wired",
    alias: "Blinds Wired",
  });
});

test("applies documented defaults and validates conflicting lines", () => {
  const result = configuration.resolveBlindConfig({ name: "Office", upPin: 5, downPin: 6 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.config.stopPin, 99);
  assert.equal(result.config.gpioChip, 0);
  assert.equal(result.config.pulseDuration, 200);
  assert.equal(result.config.activeLow, true);
  assert.equal(result.config.transitionInterval, 10);

  const invalid = configuration.resolveBlindConfig({ name: "Office", upPin: 5, downPin: 5 });
  assert.equal(invalid.config, undefined);
  assert.equal(invalid.errors.some((message) => message.includes("different GPIO lines")), true);
});

test("requests active-low GPIO lines directly in the inactive state", () => {
  const { api } = startPlatform();

  assert.equal(api.registered.length, 1);
  assert.deepEqual(gpioOperations.slice(0, 5), [
    ["chip", 0],
    ["line", 0, 17],
    ["requestOutputMode", 17, "homebridge-blinds-wired", 1],
    ["line", 0, 27],
    ["requestOutputMode", 27, "homebridge-blinds-wired", 1],
  ]);
});

test("moves to a partial position and sends the Somfy DCT stop pulse", async () => {
  const { api } = startPlatform();
  const service = api.registered[0].getService(WindowCovering);

  service.getCharacteristic(Characteristic.TargetPosition).setter(1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(service.getCharacteristic(Characteristic.CurrentPosition).value, 1);
  assert.equal(service.getCharacteristic(Characteristic.TargetPosition).value, 1);
  assert.equal(service.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.STOPPED);
  assert.equal(gpioOperations.some((operation) => operation[0] === "setValue" && operation[1] === 17 && operation[2] === 0), true);
  assert.equal(gpioOperations.some((operation) => operation[0] === "setValue" && operation[1] === 27 && operation[2] === 0), true);
});

test("restores cached position and removes stale cached accessories", () => {
  const api = createApi();
  initialisePlugin(api);
  const platform = new api.PlatformConstructor(createLog(), validPlatformConfig, api);
  const matching = new FakePlatformAccessory("Living Room", "uuid:Blinds Wired.Living Room");
  matching.context.blindPosition = 42;
  const stale = new FakePlatformAccessory("Old Blind", "uuid:old-blind");
  platform.configureAccessory(matching);
  platform.configureAccessory(stale);

  api.emit("didFinishLaunching");

  assert.equal(api.registered.length, 0);
  assert.deepEqual(api.unregistered, [stale]);
  assert.equal(matching.getService(WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value, 42);
});

test("reports GPIO initialization failure without crashing Homebridge", () => {
  failGpioRequest = true;
  const { api, log } = startPlatform();
  const service = api.registered[0].getService(WindowCovering);

  assert.equal(log.messages.some(([level]) => level === "error"), true);
  assert.throws(() => service.getCharacteristic(Characteristic.TargetPosition).setter(50), /GPIO unavailable/);
});

test("deactivates and releases all GPIO lines during shutdown", () => {
  const { api } = startPlatform();
  api.emit("shutdown");

  assert.deepEqual(gpioOperations.filter(([operation]) => operation === "release"), [
    ["release", 17],
    ["release", 27],
  ]);
  assert.equal(gpioOperations.some((operation) => operation[0] === "setValue" && operation[2] === 1), true);
});

test("invalid configuration does not reserve GPIO or register an accessory", () => {
  const { api, log } = startPlatform({
    platform: "Blinds Wired",
    blinds: [{ name: "Invalid", upPin: 17, downPin: 17 }],
  });

  assert.equal(api.registered.length, 0);
  assert.equal(gpioOperations.length, 0);
  assert.equal(log.messages.some(([level]) => level === "error"), true);
});
