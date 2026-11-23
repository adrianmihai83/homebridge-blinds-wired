"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const initialisePlugin = require("../dist/index.js");
const { configuration } = require("../dist/blindsWired-platform.js");
const { LibgpiodV2Manager } = require("../dist/gpio-manager.js");

function characteristic(name, values = {}) { return Object.assign({ name }, values); }
const Characteristic = {
  CurrentPosition: characteristic("CurrentPosition"),
  TargetPosition: characteristic("TargetPosition"),
  PositionState: characteristic("PositionState", { DECREASING: 0, INCREASING: 1, STOPPED: 2 }),
  Manufacturer: characteristic("Manufacturer"), Model: characteristic("Model"),
  SerialNumber: characteristic("SerialNumber"), FirmwareRevision: characteristic("FirmwareRevision"),
};

class FakeCharacteristic {
  onGet(handler) { this.getter = handler; return this; }
  onSet(handler) { this.setter = handler; return this; }
}
class FakeService {
  constructor(name = "") { this.displayName = name; this.characteristics = new Map(); }
  getCharacteristic(item) {
    if (!this.characteristics.has(item)) this.characteristics.set(item, new FakeCharacteristic());
    return this.characteristics.get(item);
  }
  updateCharacteristic(item, value) { this.getCharacteristic(item).value = value; return this; }
  setCharacteristic(item, value) { return this.updateCharacteristic(item, value); }
}
class WindowCovering extends FakeService {}
class AccessoryInformation extends FakeService {}
const Service = { WindowCovering, AccessoryInformation };

class FakePlatformAccessory {
  constructor(name, uuid) {
    this.displayName = name; this.UUID = uuid; this.context = {}; this.services = [new AccessoryInformation()];
  }
  getService(ServiceType) { return this.services.find((service) => service instanceof ServiceType); }
  addService(ServiceType, name) { const service = new ServiceType(name); this.services.push(service); return service; }
}

function createApi() {
  const api = new EventEmitter();
  api.hap = { Service, Characteristic, uuid: { generate: (value) => `uuid:${value}` } };
  api.platformAccessory = FakePlatformAccessory;
  api.registered = []; api.unregistered = []; api.updated = [];
  api.registerPlatform = (plugin, alias, Constructor) => { api.PlatformConstructor = Constructor; api.platformRegistration = { plugin, alias }; };
  api.registerPlatformAccessories = (_plugin, _alias, accessories) => api.registered.push(...accessories);
  api.unregisterPlatformAccessories = (_plugin, _alias, accessories) => api.unregistered.push(...accessories);
  api.updatePlatformAccessories = (accessories) => api.updated.push(...accessories);
  return api;
}

function createLog() {
  const messages = [];
  const log = (message) => messages.push(["log", message]);
  for (const level of ["debug", "info", "warn", "error"]) log[level] = (...args) => messages.push([level, ...args]);
  log.messages = messages;
  return log;
}

class FakeGpioManager {
  constructor(definitions, options = {}) { this.definitions = definitions; this.options = options; this.operations = []; }
  initialize() { this.operations.push(["initialize"]); if (this.options.initializeError) throw this.options.initializeError; }
  setValues(values) {
    this.operations.push(["setValues", values.map((value) => ({ ...value }))]);
    if (this.options.setError) throw this.options.setError;
  }
  shutdown() { this.operations.push(["shutdown"]); }
}

const validPlatformConfig = {
  platform: "Blinds Wired",
  blinds: [{ name: "Living Room", upPin: 17, downPin: 27, stopPin: 99, gpioChip: 0,
    pulseDuration: 20, activeLow: true, transitionInterval: 0 }],
};

function makePlatform(config = validPlatformConfig, gpioOptions = {}) {
  const api = createApi(); initialisePlugin(api); const log = createLog();
  const platform = new api.PlatformConstructor(log, config, api);
  let gpio;
  platform.gpioManagerFactory = (definitions) => { gpio = new FakeGpioManager(definitions, gpioOptions); return gpio; };
  return { api, log, platform, get gpio() { return gpio; } };
}

function startPlatform(config = validPlatformConfig, gpioOptions = {}) {
  const result = makePlatform(config, gpioOptions); result.api.emit("didFinishLaunching"); return result;
}

test("registers the Homebridge 2 dynamic platform", () => {
  const api = createApi(); initialisePlugin(api);
  assert.deepEqual(api.platformRegistration, { plugin: "homebridge-blinds-wired", alias: "Blinds Wired" });
});

test("applies defaults and validates conflicting lines", () => {
  const result = configuration.resolveBlindConfig({ name: "Office", upPin: 5, downPin: 6 });
  assert.deepEqual(result.errors, []);
  assert.deepEqual({ stopPin: result.config.stopPin, gpioChip: result.config.gpioChip,
    pulseDuration: result.config.pulseDuration, activeLow: result.config.activeLow,
    transitionInterval: result.config.transitionInterval },
  { stopPin: 99, gpioChip: 0, pulseDuration: 200, activeLow: true, transitionInterval: 10 });
  assert.equal(configuration.resolveBlindConfig({ name: "Office", upPin: 5, downPin: 5 }).config, undefined);
});

test("initializes all lines once with BCM chip, active-low and persistent ownership", () => {
  const result = startPlatform();
  assert.equal(result.api.registered.length, 1);
  assert.deepEqual(result.gpio.definitions, [
    { chip: 0, offset: 17, activeLow: true }, { chip: 0, offset: 27, activeLow: true },
  ]);
  assert.deepEqual(result.gpio.operations, [["initialize"]]);
});

test("pulses active-low outputs logically and sends atomic Somfy DCT stop", async () => {
  const result = startPlatform();
  const service = result.api.registered[0].getService(WindowCovering);
  service.getCharacteristic(Characteristic.TargetPosition).setter(1);
  await new Promise((resolve) => setTimeout(resolve, 8));
  const writes = result.gpio.operations.filter(([operation]) => operation === "setValues").map(([, values]) => values);
  assert.equal(writes.some((values) => values[0].active && !values[1].active), true);
  assert.equal(writes.some((values) => values[0].active && values[1].active), true);
  assert.equal(service.getCharacteristic(Characteristic.CurrentPosition).value, 1);
  assert.equal(service.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.STOPPED);
});

test("back-to-back commands cancel the previous pulse without leaving a stale timer", async () => {
  const result = startPlatform();
  const target = result.api.registered[0].getService(WindowCovering).getCharacteristic(Characteristic.TargetPosition);
  target.setter(100);
  target.setter(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const writes = result.gpio.operations.filter(([operation]) => operation === "setValues");
  const finalValues = writes.at(-1)[1];
  assert.equal(finalValues.every((value) => value.active === false), true);
});

test("reports initialization and write errors without crashing Homebridge", () => {
  const initialization = startPlatform(validPlatformConfig, { initializeError: new Error("GPIO unavailable") });
  const setter = initialization.api.registered[0].getService(WindowCovering)
    .getCharacteristic(Characteristic.TargetPosition).setter;
  assert.throws(() => setter(50), /GPIO unavailable/);
  assert.equal(initialization.log.messages.some(([level, , message]) => level === "error" && String(message).includes("GPIO unavailable")), true);

  const write = startPlatform(validPlatformConfig, { setError: new Error("write failed") });
  const writeSetter = write.api.registered[0].getService(WindowCovering)
    .getCharacteristic(Characteristic.TargetPosition).setter;
  assert.throws(() => writeSetter(50), /write failed/);
});

test("shutdown cancels timers, writes inactive and then releases the shared manager", () => {
  const result = startPlatform();
  const setter = result.api.registered[0].getService(WindowCovering).getCharacteristic(Characteristic.TargetPosition).setter;
  setter(100); result.api.emit("shutdown");
  const final = result.gpio.operations.slice(-2);
  assert.equal(final[0][0], "setValues");
  assert.equal(final[0][1].every((value) => !value.active), true);
  assert.deepEqual(final[1], ["shutdown"]);
});

test("restores cached position and removes stale cached accessories", () => {
  const result = makePlatform();
  const matching = new FakePlatformAccessory("Living Room", "uuid:Blinds Wired.Living Room"); matching.context.blindPosition = 42;
  const stale = new FakePlatformAccessory("Old Blind", "uuid:old-blind");
  result.platform.configureAccessory(matching); result.platform.configureAccessory(stale);
  result.api.emit("didFinishLaunching");
  assert.deepEqual(result.api.unregistered, [stale]);
  assert.equal(matching.getService(WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value, 42);
});

test("invalid or cross-blind duplicate GPIO configuration reserves no duplicate lines", () => {
  const result = startPlatform({ platform: "Blinds Wired", blinds: [
    { name: "One", upPin: 17, downPin: 27 },
    { name: "Two", upPin: 17, downPin: 22 },
    { name: "Invalid", upPin: 4, downPin: 4 },
  ] });
  assert.equal(result.api.registered.length, 1);
  assert.equal(result.gpio.definitions.length, 2);
  assert.equal(result.log.messages.filter(([level]) => level === "error").length, 2);
});

function createNativeBindings(options = {}) {
  const operations = [];
  let id = 0;
  const handle = (name) => `${name}-${++id}`;
  return {
    operations,
    chipOpen(path) { operations.push(["chipOpen", path]); return handle("chip"); },
    chipClose(chip) { operations.push(["chipClose", chip]); },
    lineSettingsNew() { const value = handle("settings"); operations.push(["settingsNew", value]); return value; },
    lineSettingsFree(value) { operations.push(["settingsFree", value]); },
    lineSettingsSetDirection(_settings, direction) { operations.push(["direction", direction]); return 0; },
    lineSettingsSetActiveLow(_settings, activeLow) { operations.push(["activeLow", activeLow]); },
    lineSettingsSetOutputValue(_settings, value) { operations.push(["initialSetting", value]); return 0; },
    lineConfigNew() { return handle("lineConfig"); }, lineConfigFree() {},
    lineConfigAddLineSettings(_config, offsets, count) { operations.push(["add", [...offsets], count]); return 0; },
    lineConfigSetOutputValues(_config, values, count) { operations.push(["initialValues", [...values], count]); return 0; },
    requestConfigNew() { return handle("requestConfig"); }, requestConfigFree() {},
    requestConfigSetConsumer(_config, consumer) { operations.push(["consumer", consumer]); },
    chipRequestLines() { operations.push(["request"]); return options.failRequest ? null : handle("request"); },
    lineRequestSetValuesSubset(_request, count, offsets, values) {
      operations.push(["write", count, [...offsets], [...values]]); return 0;
    },
    lineRequestRelease(request) { operations.push(["release", request]); }, errno() { return 16; },
  };
}

test("native libgpiod v2 manager requests initial INACTIVE values atomically and releases safely", () => {
  const bindings = createNativeBindings();
  const manager = new LibgpiodV2Manager([
    { chip: 0, offset: 17, activeLow: true }, { chip: 0, offset: 27, activeLow: false },
  ], bindings);
  manager.initialize(); manager.setValues([{ chip: 0, offset: 17, active: true }]); manager.shutdown();
  assert.deepEqual(bindings.operations.filter(([name]) => name === "activeLow"), [["activeLow", true], ["activeLow", false]]);
  assert.deepEqual(bindings.operations.find(([name]) => name === "initialValues"), ["initialValues", [0, 0], 2]);
  const shutdownWrite = bindings.operations.filter(([name]) => name === "write").at(-1);
  const releaseIndex = bindings.operations.findIndex(([name]) => name === "release");
  assert.deepEqual(shutdownWrite.slice(1), [2, [17, 27], [0, 0]]);
  assert.equal(bindings.operations.indexOf(shutdownWrite) < releaseIndex, true);
});

test("native manager cleans up an earlier chip when later initialization fails", () => {
  const bindings = createNativeBindings();
  let requestCount = 0;
  bindings.chipRequestLines = () => (++requestCount === 1 ? "request-ok" : null);
  const manager = new LibgpiodV2Manager([
    { chip: 0, offset: 17, activeLow: true }, { chip: 1, offset: 5, activeLow: true },
  ], bindings);
  assert.throws(() => manager.initialize(), /request GPIO lines/);
  assert.equal(bindings.operations.some(([name, request]) => name === "release" && request === "request-ok"), true);
});
