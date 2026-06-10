declare module "node-libgpiod" {
  export class Chip {
    constructor(chip: number);
  }

  export class Line {
    constructor(chip: Chip, line: number);
    requestOutputMode(): void;
    setValue(value: number): void;
  }
}
