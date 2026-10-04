import type { PositionInput } from './calculator.js';

export function mergePositionInputs(inputs1: PositionInput[], inputs2: PositionInput[]): PositionInput[] {
  const map = new Map<string, PositionInput>();
  const add = (arr: PositionInput[]) => {
    for (const it of arr) {
      const key = it.row.isin;
      if (!map.has(key)) {
        map.set(key, {
          row: {
            isin: it.row.isin,
            name: it.row.name,
            category: it.row.category,
            quantityEnd: it.row.quantityEnd,
            valueEnd: it.row.valueEnd,
          },
          cost: it.cost
            ? {
                isin: it.cost.isin,
                name: it.cost.name,
                buyQty: it.cost.buyQty,
                buyCost: it.cost.buyCost,
                buyNkd: it.cost.buyNkd,
                buyFee: it.cost.buyFee,
                netQty: it.cost.netQty,
              }
            : undefined,
          security: it.security,
          ofzCurve: it.ofzCurve,
        });
      } else {
        const ex = map.get(key)!;
        ex.row.quantityEnd += it.row.quantityEnd;
        ex.row.valueEnd += it.row.valueEnd;
        if (ex.cost && it.cost) {
          ex.cost.buyQty += it.cost.buyQty;
          ex.cost.buyCost += it.cost.buyCost;
          ex.cost.buyNkd += it.cost.buyNkd;
          ex.cost.buyFee += it.cost.buyFee;
          ex.cost.netQty += it.cost.netQty;
        } else if (it.cost) {
          ex.cost = {
            isin: it.cost.isin,
            name: it.cost.name,
            buyQty: it.cost.buyQty,
            buyCost: it.cost.buyCost,
            buyNkd: it.cost.buyNkd,
            buyFee: it.cost.buyFee,
            netQty: it.cost.netQty,
          };
        }
      }
    }
  };
  add(inputs1);
  add(inputs2);
  return Array.from(map.values());
}
