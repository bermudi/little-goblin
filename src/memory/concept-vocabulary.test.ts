import { describe, it, expect } from "bun:test";
import {
  deriveConceptTags,
  classifyConceptTagScript,
  summarizeConceptTagScriptCoverage,
} from "./concept-vocabulary.ts";

describe("concept-vocabulary", () => {
  describe("deriveConceptTags", () => {
    it("extracts glossary terms such as backup, router, gateway, and failover", () => {
      const tags = deriveConceptTags({
        snippet: "The backup router and gateway for failover.",
      });
      expect(tags).toEqual(["backup", "failover", "gateway", "router"]);
    });

    it("extracts compound tokens like edge-tts", () => {
      const tags = deriveConceptTags({
        snippet: "Enable edge-tts for voice synthesis.",
      });
      expect(tags).toEqual(["edge-tts", "enable", "edge", "tts", "voice", "synthesis"]);
    });

    it("ignores stop words and short tokens", () => {
      const tags = deriveConceptTags({
        snippet: "the and of a to in xx for daily backup",
      });
      expect(tags).toEqual(["backup"]);
    });

    it("respects the limit parameter", () => {
      const tags = deriveConceptTags({
        snippet: "alpha bravo charlie delta echo foxtrot golf hotel",
        limit: 3,
      });
      expect(tags).toEqual(["alpha", "bravo", "charlie"]);
      expect(tags).toHaveLength(3);
    });

    it("returns an empty array when the limit is zero", () => {
      expect(deriveConceptTags({ snippet: "alpha bravo charlie", limit: 0 })).toEqual([]);
    });

    it("includes basename from path", () => {
      const tags = deriveConceptTags({
        path: "/foo/bar/network-config",
        snippet: "diagram",
      });
      expect(tags).toContain("network");
      expect(tags).toContain("network-config");
    });

    it("handles CJK tokens", () => {
      const tags = deriveConceptTags({
        snippet: "路由器とゲートウェイのバックアップを設定する",
      });
      expect(tags).toContain("バックアップ");
      expect(tags).toContain("ゲートウェイ");
      expect(tags).toContain("路由器");
      expect(tags).toContain("設定");
      expect(tags).not.toContain("と");
      expect(tags).not.toContain("の");
      expect(tags).not.toContain("を");
      expect(tags).not.toContain("する");
    });
  });

  describe("classifyConceptTagScript", () => {
    it("classifies latin tags", () => {
      expect(classifyConceptTagScript("router")).toBe("latin");
      expect(classifyConceptTagScript("edge-tts")).toBe("latin");
    });

    it("classifies cjk tags", () => {
      expect(classifyConceptTagScript("路由器")).toBe("cjk");
      expect(classifyConceptTagScript("バックアップ")).toBe("cjk");
      expect(classifyConceptTagScript("라우터")).toBe("cjk");
    });

    it("classifies mixed latin and cjk tags", () => {
      expect(classifyConceptTagScript("backup-备份")).toBe("mixed");
      expect(classifyConceptTagScript("alpha测试")).toBe("mixed");
    });

    it("classifies other scripts", () => {
      expect(classifyConceptTagScript("δρομολογητής")).toBe("other");
    });
  });

  describe("summarizeConceptTagScriptCoverage", () => {
    it("aggregates coverage counts correctly", () => {
      const coverage = summarizeConceptTagScriptCoverage([
        ["router", "backup"],
        ["路由器"],
        ["백업"],
        ["backup", "路由器"],
        ["δρομολογητής"],
      ]);
      expect(coverage).toEqual({
        latinEntryCount: 1,
        cjkEntryCount: 2,
        mixedEntryCount: 1,
        otherEntryCount: 1,
      });
    });
  });
});
