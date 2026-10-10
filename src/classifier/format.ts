const intFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const decFormat = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtInt = (n: number): string => intFormat.format(Math.round(n));
const ratioFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
export const fmtRatio = (n: number): string => ratioFormat.format(n);
export const fmtDec = (n: number): string => decFormat.format(n);
export const fmtPct = (fraction: number): string => `${intFormat.format(Math.round(fraction * 100))}%`;
export const plural = (n: number, one: string, many: string): string => `${fmtInt(n)} ${n === 1 ? one : many}`;
