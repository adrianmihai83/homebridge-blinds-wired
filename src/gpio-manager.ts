/* Copyright(C) 2026, Adrian Mihai. All rights reserved.
 * Persistent libgpiod v2 GPIO ownership through Koffi FFI.
 */
import { getSystemErrorName } from "util";

import { PLUGIN_NAME } from "./settings";

const INACTIVE = 0;
const ACTIVE = 1;
const OUTPUT = 3;
type NativeHandle = unknown;

export interface GpioLineDefinition {
  chip: number;
  offset: number;
  activeLow: boolean;
}

export interface GpioValue {
  chip: number;
  offset: number;
  active: boolean;
}

export interface GpioManager {
  initialize(): void;
  setValues(values: readonly GpioValue[]): void;
  shutdown(): void;
}

/** Narrow interface so the native manager can be tested without GPIO hardware. */
export interface LibgpiodBindings {
  chipOpen(path: string): NativeHandle;
  chipClose(chip: NativeHandle): void;
  lineSettingsNew(): NativeHandle;
  lineSettingsFree(settings: NativeHandle): void;
  lineSettingsSetDirection(settings: NativeHandle, direction: number): number;
  lineSettingsSetActiveLow(settings: NativeHandle, activeLow: boolean): void;
  lineSettingsSetOutputValue(settings: NativeHandle, value: number): number;
  lineConfigNew(): NativeHandle;
  lineConfigFree(config: NativeHandle): void;
  lineConfigAddLineSettings(config: NativeHandle, offsets: Uint32Array, count: number, settings: NativeHandle): number;
  lineConfigSetOutputValues(config: NativeHandle, values: Int32Array, count: number): number;
  requestConfigNew(): NativeHandle;
  requestConfigFree(config: NativeHandle): void;
  requestConfigSetConsumer(config: NativeHandle, consumer: string): void;
  chipRequestLines(chip: NativeHandle, requestConfig: NativeHandle, lineConfig: NativeHandle): NativeHandle;
  lineRequestSetValuesSubset(
    request: NativeHandle,
    count: number,
    offsets: Uint32Array,
    values: Int32Array,
  ): number;
  lineRequestRelease(request: NativeHandle): void;
  errno(): number;
}

interface ChipRequest {
  chip: NativeHandle;
  request: NativeHandle;
  offsets: number[];
}

function isNullHandle(handle: NativeHandle): boolean {
  return handle === null || handle === undefined || handle === 0;
}

export class LibgpiodV2Manager implements GpioManager {
  private readonly requests = new Map<number, ChipRequest>();
  private initializationError?: Error;
  private initialized = false;

  constructor(
    private readonly definitions: readonly GpioLineDefinition[],
    private readonly bindings: LibgpiodBindings = loadLibgpiodV2Bindings(),
  ) {}

  initialize(): void {
    if (this.initialized) {
      return;
    }
    try {
      const byChip = new Map<number, GpioLineDefinition[]>();
      for (const definition of this.definitions) {
        const definitions = byChip.get(definition.chip) ?? [];
        if (definitions.some((candidate) => candidate.offset === definition.offset)) {
          throw new Error(`GPIO ${definition.chip}:${definition.offset} is configured more than once`);
        }
        definitions.push(definition);
        byChip.set(definition.chip, definitions);
      }
      for (const [chipNumber, definitions] of byChip) {
        this.requests.set(chipNumber, this.requestChip(chipNumber, definitions));
      }
      this.initialized = true;
      this.initializationError = undefined;
    } catch (error) {
      this.initializationError = this.asError(error);
      try {
        this.releaseRequests();
      } catch {
        // Preserve the initialization failure that explains why GPIO is unavailable.
      }
      throw this.initializationError;
    }
  }

  setValues(values: readonly GpioValue[]): void {
    this.ensureAvailable();
    const byChip = new Map<number, GpioValue[]>();
    for (const value of values) {
      const chipValues = byChip.get(value.chip) ?? [];
      chipValues.push(value);
      byChip.set(value.chip, chipValues);
    }
    for (const [chipNumber, chipValues] of byChip) {
      const owned = this.requests.get(chipNumber);
      if (!owned) {
        throw new Error(`GPIO chip ${chipNumber} is not owned by the plugin`);
      }
      for (const value of chipValues) {
        if (!owned.offsets.includes(value.offset)) {
          throw new Error(`GPIO ${chipNumber}:${value.offset} is not owned by the plugin`);
        }
      }
      const offsets = Uint32Array.from(chipValues, (value) => value.offset);
      const logicalValues = Int32Array.from(chipValues, (value) => value.active ? ACTIVE : INACTIVE);
      this.checkResult(
        this.bindings.lineRequestSetValuesSubset(owned.request, chipValues.length, offsets, logicalValues),
        `set GPIO values on gpiochip${chipNumber}`,
      );
    }
  }

  shutdown(): void {
    // Releasing a line does not guarantee its electrical level. First drive
    // everything inactive, then release; hardware bias covers the period after.
    let firstError: unknown;
    for (const [chipNumber, owned] of this.requests) {
      try {
        this.checkResult(
          this.bindings.lineRequestSetValuesSubset(
            owned.request,
            owned.offsets.length,
            Uint32Array.from(owned.offsets),
            new Int32Array(owned.offsets.length).fill(INACTIVE),
          ),
          `set gpiochip${chipNumber} inactive during shutdown`,
        );
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      this.releaseRequests();
    } catch (error) {
      firstError ??= error;
    }
    this.initialized = false;
    if (firstError) {
      throw firstError;
    }
  }

  private requestChip(chipNumber: number, definitions: readonly GpioLineDefinition[]): ChipRequest {
    const chip = this.bindings.chipOpen(`/dev/gpiochip${chipNumber}`);
    if (isNullHandle(chip)) {
      throw this.nativeError(`open /dev/gpiochip${chipNumber}`);
    }

    let lineConfig: NativeHandle | undefined;
    let requestConfig: NativeHandle | undefined;
    try {
      lineConfig = this.requireHandle(this.bindings.lineConfigNew(), "allocate line configuration");
      requestConfig = this.requireHandle(this.bindings.requestConfigNew(), "allocate request configuration");
    } catch (error) {
      if (lineConfig) {
        this.bindings.lineConfigFree(lineConfig);
      }
      this.bindings.chipClose(chip);
      throw error;
    }

    try {
      this.bindings.requestConfigSetConsumer(requestConfig, PLUGIN_NAME);
      for (const definition of definitions) {
        const settings = this.requireHandle(this.bindings.lineSettingsNew(), "allocate line settings");
        try {
          this.checkResult(this.bindings.lineSettingsSetDirection(settings, OUTPUT),
            `configure GPIO ${chipNumber}:${definition.offset} as output`);
          this.bindings.lineSettingsSetActiveLow(settings, definition.activeLow);
          this.checkResult(this.bindings.lineSettingsSetOutputValue(settings, INACTIVE),
            `configure GPIO ${chipNumber}:${definition.offset} inactive`);
          this.checkResult(this.bindings.lineConfigAddLineSettings(
            lineConfig, Uint32Array.of(definition.offset), 1, settings,
          ), `add GPIO ${chipNumber}:${definition.offset} to line request`);
        } finally {
          this.bindings.lineSettingsFree(settings);
        }
      }

      // Direction and all initial INACTIVE values are applied atomically by
      // the kernel while acquiring this persistent request.
      const initialValues = new Int32Array(definitions.length).fill(INACTIVE);
      this.checkResult(this.bindings.lineConfigSetOutputValues(lineConfig, initialValues, initialValues.length),
        `set initial values on gpiochip${chipNumber}`);
      const request = this.bindings.chipRequestLines(chip, requestConfig, lineConfig);
      if (isNullHandle(request)) {
        throw this.nativeError(`request GPIO lines on gpiochip${chipNumber}`);
      }
      return { chip, request, offsets: definitions.map((definition) => definition.offset) };
    } catch (error) {
      this.bindings.chipClose(chip);
      throw error;
    } finally {
      this.bindings.requestConfigFree(requestConfig);
      this.bindings.lineConfigFree(lineConfig);
    }
  }

  private releaseRequests(): void {
    let firstError: unknown;
    for (const owned of this.requests.values()) {
      try {
        this.bindings.lineRequestRelease(owned.request);
      } catch (error) {
        firstError ??= error;
      } finally {
        try {
          this.bindings.chipClose(owned.chip);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    this.requests.clear();
    if (firstError) {
      throw firstError;
    }
  }

  private ensureAvailable(): void {
    if (this.initializationError) {
      throw this.initializationError;
    }
    if (!this.initialized) {
      throw new Error("GPIO has not been initialized");
    }
  }

  private requireHandle(handle: NativeHandle, operation: string): NativeHandle {
    if (isNullHandle(handle)) {
      throw this.nativeError(operation);
    }
    return handle;
  }

  private checkResult(result: number, operation: string): void {
    if (result < 0) {
      throw this.nativeError(operation);
    }
  }

  private nativeError(operation: string): Error {
    const errno = this.bindings.errno();
    let name = `errno ${errno}`;
    try {
      name = getSystemErrorName(-Math.abs(errno));
    } catch {
      // Retain numeric errno when Node does not know it.
    }
    return new Error(`Unable to ${operation}: ${name}`);
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export type GpioManagerFactory = (definitions: readonly GpioLineDefinition[]) => GpioManager;
export const createGpioManager: GpioManagerFactory = (definitions) => new LibgpiodV2Manager(definitions);

function loadLibgpiodV2Bindings(): LibgpiodBindings {
  const koffi = require("koffi") as typeof import("koffi");
  let library: import("koffi").LibraryHandle;
  try {
    library = koffi.load("libgpiod.so.3");
  } catch (error) {
    throw new Error(`Unable to load libgpiod.so.3 (install libgpiod 2.x): ${error instanceof Error ? error.message : String(error)}`);
  }
  const fn = (definition: string) => library.func(definition) as (...args: never[]) => unknown;
  return {
    chipOpen: fn("void *gpiod_chip_open(const char *path)"),
    chipClose: fn("void gpiod_chip_close(void *chip)"),
    lineSettingsNew: fn("void *gpiod_line_settings_new(void)"),
    lineSettingsFree: fn("void gpiod_line_settings_free(void *settings)"),
    lineSettingsSetDirection: fn("int gpiod_line_settings_set_direction(void *settings, int direction)"),
    lineSettingsSetActiveLow: fn("void gpiod_line_settings_set_active_low(void *settings, bool active_low)"),
    lineSettingsSetOutputValue: fn("int gpiod_line_settings_set_output_value(void *settings, int value)"),
    lineConfigNew: fn("void *gpiod_line_config_new(void)"),
    lineConfigFree: fn("void gpiod_line_config_free(void *config)"),
    lineConfigAddLineSettings: fn("int gpiod_line_config_add_line_settings(void *config, const uint32_t *offsets, size_t count, void *settings)"),
    lineConfigSetOutputValues: fn("int gpiod_line_config_set_output_values(void *config, const int32_t *values, size_t count)"),
    requestConfigNew: fn("void *gpiod_request_config_new(void)"),
    requestConfigFree: fn("void gpiod_request_config_free(void *config)"),
    requestConfigSetConsumer: fn("void gpiod_request_config_set_consumer(void *config, const char *consumer)"),
    chipRequestLines: fn("void *gpiod_chip_request_lines(void *chip, void *request_config, void *line_config)"),
    lineRequestSetValuesSubset: fn("int gpiod_line_request_set_values_subset(void *request, size_t count, const uint32_t *offsets, const int32_t *values)"),
    lineRequestRelease: fn("void gpiod_line_request_release(void *request)"),
    errno: koffi.errno,
  } as LibgpiodBindings;
}
