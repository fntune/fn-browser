import { describe, expect, it } from "vitest";

import {
  classifyHost,
  evaluateNavigationTarget,
  PERMISSIVE_ORIGIN_POLICY,
  REMOTE_ORIGIN_POLICY,
} from "../mcp/origin-policy.js";

describe("classifyHost", () => {
  it("classifies loopback", () => {
    expect(classifyHost("localhost")).toBe("loopback");
    expect(classifyHost("127.0.0.1")).toBe("loopback");
    expect(classifyHost("127.9.9.9")).toBe("loopback");
    expect(classifyHost("::1")).toBe("loopback");
    expect(classifyHost("0.0.0.0")).toBe("loopback");
  });

  it("classifies private ranges", () => {
    expect(classifyHost("10.0.0.1")).toBe("private");
    expect(classifyHost("172.16.5.4")).toBe("private");
    expect(classifyHost("172.31.255.255")).toBe("private");
    expect(classifyHost("192.168.1.1")).toBe("private");
    expect(classifyHost("fd00::1")).toBe("private");
  });

  it("does not misclassify 172.15/172.32 as private", () => {
    expect(classifyHost("172.15.0.1")).toBe("public");
    expect(classifyHost("172.32.0.1")).toBe("public");
  });

  it("classifies 100.64/10 CGNAT (Tailscale peers) as private", () => {
    expect(classifyHost("100.64.0.1")).toBe("private");
    expect(classifyHost("100.127.255.255")).toBe("private");
    expect(classifyHost("100.63.0.1")).toBe("public"); // just below the range
    expect(classifyHost("100.128.0.1")).toBe("public"); // just above
    // Alibaba metadata (100.100.100.200) still wins over the CGNAT range.
    expect(classifyHost("100.100.100.200")).toBe("cloud_metadata");
  });

  it("classifies link-local and cloud metadata (incl. embedded IPv4 forms)", () => {
    expect(classifyHost("169.254.1.1")).toBe("link_local");
    expect(classifyHost("fe80::1")).toBe("link_local");
    expect(classifyHost("169.254.169.254")).toBe("cloud_metadata");
    expect(classifyHost("100.100.100.200")).toBe("cloud_metadata");
    expect(classifyHost("metadata.google.internal")).toBe("cloud_metadata");
    // Embedded-IPv4 metadata must not slip through as link_local/public.
    expect(classifyHost("::ffff:169.254.169.254")).toBe("cloud_metadata");
    expect(classifyHost("::ffff:a9fe:a9fe")).toBe("cloud_metadata"); // canonical hex
    expect(classifyHost("64:ff9b::a9fe:a9fe")).toBe("cloud_metadata"); // NAT64
    expect(classifyHost("::ffff:100.100.100.200")).toBe("cloud_metadata");
    // AWS IPv6 IMDS lives in the ULA range but is metadata.
    expect(classifyHost("fd00:ec2::254")).toBe("cloud_metadata");
    // AWS EKS Pod Identity Agent (IPv4 + IPv6).
    expect(classifyHost("169.254.170.23")).toBe("cloud_metadata");
    expect(classifyHost("fd00:ec2::23")).toBe("cloud_metadata");
    // Google Compute Engine IPv6 metadata.
    expect(classifyHost("fd20:ce::254")).toBe("cloud_metadata");
    // Oracle OCI legacy IMDS.
    expect(classifyHost("192.0.0.192")).toBe("cloud_metadata");
    // Azure WireServer and Equinix Metal platform metadata.
    expect(classifyHost("168.63.129.16")).toBe("cloud_metadata");
    expect(classifyHost("metadata.platformequinix.com")).toBe("cloud_metadata");
    // AWS ECS task credentials — must not slip through as plain link-local.
    expect(classifyHost("169.254.170.2")).toBe("cloud_metadata");
    expect(classifyHost("169.254.1.1")).toBe("link_local"); // ordinary link-local still is
    // 6to4 (2002::/16) embedding the metadata v4.
    expect(classifyHost("2002:a9fe:a9fe::")).toBe("cloud_metadata");
  });

  it("fails closed for deprecated 6to4 while retaining metadata specificity", () => {
    expect(classifyHost("2002:a00:1::")).toBe("invalid");
    expect(classifyHost("2002:c0a8:1::")).toBe("invalid");
    expect(classifyHost("2002:808:808::")).toBe("invalid");
    expect(classifyHost("2002:7f00:1::")).toBe("invalid");
    expect(classifyHost("2002:a9fe:a9fe::")).toBe("cloud_metadata");
  });

  it("classifies IPv4-mapped IPv6 by the embedded v4 (dotted and hex forms)", () => {
    expect(classifyHost("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyHost("::ffff:10.0.0.1")).toBe("private");
    expect(classifyHost("::ffff:8.8.8.8")).toBe("public");
    // URL canonicalizes ::ffff:127.0.0.1 to the hex form — must still classify.
    expect(classifyHost("::ffff:7f00:1")).toBe("loopback");
    expect(classifyHost("[::ffff:7f00:1]")).toBe("loopback");
    expect(classifyHost("::ffff:a00:1")).toBe("private"); // 10.0.0.1
  });

  it("classifies IPv4-compatible and NAT64-embedded addresses by the embedded v4", () => {
    expect(classifyHost("::7f00:1")).toBe("loopback"); // ::127.0.0.1
    expect(classifyHost("::ffff:0:7f00:1")).toBe("loopback"); // translated
    expect(classifyHost("64:ff9b::a00:1")).toBe("private"); // NAT64 → 10.0.0.1
  });

  it("fails closed for IANA non-global ranges and allows narrower global exceptions", () => {
    for (const address of [
      "192.88.99.1",
      "100::1",
      "2001::ffff",
      "3fff::1",
      "5f00::1",
    ]) {
      expect(classifyHost(address), address).toBe("invalid");
    }
    expect(classifyHost("192.0.0.9")).toBe("public");
    expect(classifyHost("2001:20::1")).toBe("public");
  });

  it("treats a real public IPv6 as public and rejects garbage", () => {
    expect(classifyHost("2606:4700:4700::1111")).toBe("public");
    expect(classifyHost("::ffff:gggg:1")).toBe("invalid");
  });

  it("treats normal hostnames and public IPs as public", () => {
    expect(classifyHost("example.com")).toBe("public");
    expect(classifyHost("8.8.8.8")).toBe("public");
  });

  it("strips a fully-qualified trailing dot before classifying", () => {
    expect(classifyHost("metadata.google.internal.")).toBe("cloud_metadata");
    expect(classifyHost("localhost.")).toBe("loopback");
    expect(classifyHost("example.com.")).toBe("public");
  });
});

describe("evaluateNavigationTarget", () => {
  it("permissive policy allows everything reachable", () => {
    expect(evaluateNavigationTarget("http://127.0.0.1:3000", PERMISSIVE_ORIGIN_POLICY).allowed).toBe(true);
    expect(evaluateNavigationTarget("http://10.0.0.1", PERMISSIVE_ORIGIN_POLICY).allowed).toBe(true);
    expect(evaluateNavigationTarget("https://example.com", PERMISSIVE_ORIGIN_POLICY).allowed).toBe(true);
  });

  it("remote policy blocks loopback/private/link-local", () => {
    expect(evaluateNavigationTarget("http://localhost:3000", REMOTE_ORIGIN_POLICY).allowed).toBe(false);
    expect(evaluateNavigationTarget("http://10.0.0.1", REMOTE_ORIGIN_POLICY).allowed).toBe(false);
    expect(evaluateNavigationTarget("http://169.254.1.1", REMOTE_ORIGIN_POLICY).allowed).toBe(false);
    expect(evaluateNavigationTarget("https://example.com", REMOTE_ORIGIN_POLICY).allowed).toBe(true);
  });

  it("blocks SSRF via IPv6-mapped, NAT64, and alternate IPv4 encodings under remote policy", () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/", // mapped loopback (canonicalizes to hex)
      "http://[::ffff:10.0.0.1]/", // mapped private
      "http://[64:ff9b::a00:1]/", // NAT64 → 10.0.0.1
      "http://0x7f000001/", // hex IPv4 → 127.0.0.1
      "http://2130706433/", // decimal IPv4 → 127.0.0.1
      "http://0177.0.0.1/", // octal → 127.0.0.1
      "http://[::ffff:169.254.169.254]/", // mapped metadata (permissive would allow link-local!)
      "http://[64:ff9b::a9fe:a9fe]/", // NAT64 metadata
      "http://metadata.google.internal./", // trailing-dot DNS bypass
      "http://localhost./", // trailing-dot loopback bypass
    ]) {
      expect(evaluateNavigationTarget(url, REMOTE_ORIGIN_POLICY).allowed, url).toBe(false);
    }
  });

  it("always blocks the cloud metadata endpoint, even when private is allowed", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.170.23/v1/credentials/",
      "http://[fd00:ec2::23]/v1/credentials/",
      "http://[fd20:ce::254]/computeMetadata/v1/",
      "http://168.63.129.16/machine/?comp=goalstate",
      "http://metadata.platformequinix.com/metadata",
      "http://[::ffff:a83f:8110]/",
    ]) {
      const decision = evaluateNavigationTarget(url, PERMISSIVE_ORIGIN_POLICY);
      expect(decision.allowed, url).toBe(false);
      expect(decision.classification, url).toBe("cloud_metadata");
    }
  });

  it("blocks invalid special-use destinations even under permissive policy", () => {
    for (const url of [
      "http://192.88.99.1/",
      "http://[100::1]/",
      "http://[2001::ffff]/",
      "http://[3fff::1]/",
      "http://[5f00::1]/",
    ]) {
      expect(
        evaluateNavigationTarget(url, PERMISSIVE_ORIGIN_POLICY).allowed,
        url,
      ).toBe(false);
    }
  });

  it("blocks non-http(s) schemes", () => {
    expect(evaluateNavigationTarget("file:///etc/passwd", PERMISSIVE_ORIGIN_POLICY).allowed).toBe(false);
    expect(evaluateNavigationTarget("chrome://settings", PERMISSIVE_ORIGIN_POLICY).allowed).toBe(false);
  });

  it("allows about:blank", () => {
    expect(evaluateNavigationTarget("about:blank", REMOTE_ORIGIN_POLICY).allowed).toBe(true);
  });

  it("rejects invalid URLs", () => {
    const decision = evaluateNavigationTarget("not a url", REMOTE_ORIGIN_POLICY);
    expect(decision.allowed).toBe(false);
    expect(decision.classification).toBe("invalid");
  });

  it("allowHosts overrides classification", () => {
    const policy = { ...REMOTE_ORIGIN_POLICY, allowHosts: new Set(["10.0.0.5"]) };
    expect(evaluateNavigationTarget("http://10.0.0.5:8080", policy).allowed).toBe(true);
  });
});
