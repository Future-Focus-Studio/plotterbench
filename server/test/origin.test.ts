import { describe, it, expect } from "vitest";
import { isLocalOrigin } from "../src/origin.js";

describe("isLocalOrigin", () => {
  it("accepts bare loopback origins", () => {
    expect(isLocalOrigin("http://localhost:49173")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:49787")).toBe(true);
    expect(isLocalOrigin("http://[::1]:49787")).toBe(true);
  });

  it("accepts *.localhost subdomains (reverse-proxy setups)", () => {
    expect(isLocalOrigin("http://plotterbench.localhost")).toBe(true);
    expect(isLocalOrigin("https://admin.localhost:8443")).toBe(true);
  });

  it("rejects non-loopback origins", () => {
    expect(isLocalOrigin("http://evil.example.com")).toBe(false);
    expect(isLocalOrigin("http://192.168.1.5:49787")).toBe(false);
  });

  it("rejects hostnames that merely contain 'localhost'", () => {
    expect(isLocalOrigin("http://localhost.attacker.com")).toBe(false);
    expect(isLocalOrigin("http://notlocalhost")).toBe(false);
  });

  it("rejects malformed origins", () => {
    expect(isLocalOrigin("not a url")).toBe(false);
    expect(isLocalOrigin("")).toBe(false);
  });
});
