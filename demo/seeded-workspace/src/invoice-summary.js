export function summarizeInvoice(items, taxRate = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const tax = Number((subtotal * taxRate).toFixed(2));
  const total = Number((subtotal + tax).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    tax,
    total
  };
}
