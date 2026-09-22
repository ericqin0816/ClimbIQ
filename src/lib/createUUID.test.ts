import { afterEach, describe, expect, it, vi } from "vitest";
import { createUUID } from "./createUUID";

afterEach(() => vi.unstubAllGlobals());

describe("secure UUID generation", () => {
  it("calls the native method with its Crypto receiver and skips the fallback", () => {
    const expected = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const provider = {
      randomUUID() { expect(this).toBe(provider); return expected; },
      getRandomValues: vi.fn(),
    };
    expect(createUUID(provider)).toBe(expected);
    expect(provider.getRandomValues).not.toHaveBeenCalled();
  });

  it("uses the secure random byte provider with its receiver and preserves all non-format bits", () => {
    const provider = {
      getRandomValues(bytes: Uint8Array) {
        expect(this).toBe(provider);
        expect(bytes).toHaveLength(16);
        bytes.set(Array.from({ length: 16 }, (_, index) => index));
        return bytes;
      },
    };
    expect(createUUID(provider)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it.each([0x00, 0x40, 0x80, 0xc0, 0xff])("sets v4 and RFC variant bits for random byte pattern %s", pattern => {
    const id = createUUID({ getRandomValues: bytes => bytes.fill(pattern) });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id[15], 16)).toBe(pattern & 0x0f);
    expect(Number.parseInt(id[19], 16)).toBe(((pattern >> 4) & 3) | 8);
  });

  it("gets fresh secure bytes on every request when the native method is absent", () => {
    let call = 0;
    const provider = { getRandomValues: vi.fn((bytes: Uint8Array) => bytes.fill(++call)) };
    expect(createUUID(provider)).not.toBe(createUUID(provider));
    expect(provider.getRandomValues).toHaveBeenCalledTimes(2);
  });

  it("handles non-callable randomUUID properties by using secure bytes", () => {
    const provider = { randomUUID: null, getRandomValues: (bytes: Uint8Array) => bytes.fill(255) };
    expect(createUUID(provider as unknown as Crypto)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("fails clearly when secure randomness is unavailable rather than using Math.random", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createUUID()).toThrow("Secure random IDs are unavailable");
    expect(() => createUUID({})).toThrow("Update iOS or use a supported browser");
  });

  it("does not hide native generator or random-byte provider failures", () => {
    const error = new Error("Secure provider failed");
    const getRandomValues = vi.fn();
    expect(() => createUUID({ randomUUID() { throw error; }, getRandomValues })).toThrow(error);
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(() => createUUID({ getRandomValues() { throw error; } })).toThrow(error);
  });
});
