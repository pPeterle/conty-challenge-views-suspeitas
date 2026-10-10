import { describe, expect, it } from "vitest";
import { binomCdf, clopperPearson } from "../../src/evaluation/binomial.ts";

describe("intervalo de Clopper-Pearson", () => {
  it("bate com a forma fechada quando não há nenhum caso: [0, 1 - (α/2)^(1/n)]", () => {
    const { low, high } = clopperPearson(0, 10);
    expect(low).toBe(0);
    expect(high).toBeCloseTo(1 - 0.025 ** (1 / 10), 6);
  });

  it("bate com a forma fechada quando todos são casos", () => {
    const { low, high } = clopperPearson(10, 10);
    expect(high).toBe(1);
    expect(low).toBeCloseTo(0.025 ** (1 / 10), 6);
  });

  it("é simétrico e bate com o valor tabelado para 5 em 10 (0,1871 a 0,8129)", () => {
    const { low, high } = clopperPearson(5, 10);
    expect(low).toBeCloseTo(0.1871, 4);
    expect(high).toBeCloseTo(0.8129, 4);
  });

  it("a binomial acumulada soma 1 e confere um valor conhecido", () => {
    expect(binomCdf(20, 20, 0.3)).toBeCloseTo(1, 12);
    // P(X <= 2) para Binomial(10, 0,5) = 56/1024.
    expect(binomCdf(2, 10, 0.5)).toBeCloseTo(56 / 1024, 12);
  });
});
