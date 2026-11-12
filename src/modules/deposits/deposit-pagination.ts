export const DEPOSIT_PAGE_SIZE = 10;

export function depositPageArgs(page: number) {
  return { skip: (page - 1) * DEPOSIT_PAGE_SIZE, take: DEPOSIT_PAGE_SIZE + 1 };
}

export function depositPage<T>(rows: T[]) {
  return { items: rows.slice(0, DEPOSIT_PAGE_SIZE), hasNext: rows.length > DEPOSIT_PAGE_SIZE };
}
