const intFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const decFormat = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtInt = (n: number): string => intFormat.format(Math.round(n));
const ratioFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
export const fmtRatio = (n: number): string => ratioFormat.format(n);
export const fmtDec = (n: number): string => decFormat.format(n);
export const fmtPct = (fraction: number): string => `${intFormat.format(Math.round(fraction * 100))}%`;
export const plural = (n: number, one: string, many: string): string => `${fmtInt(n)} ${n === 1 ? one : many}`;
/** Views por hora no texto: "menos de 1 view/h", "1 view/h", "120 views/h". */
export const fmtRate = (n: number): string => {
  if (n < 0.5) return "menos de 1 view/h";
  const rounded = Math.round(n);
  return `${fmtInt(rounded)} ${rounded === 1 ? "view" : "views"}/h`;
};
/** Porcentagem com uma casa: "2,1%". */
export const fmtPctDec = (fraction: number): string =>
  `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(fraction * 100)}%`;
