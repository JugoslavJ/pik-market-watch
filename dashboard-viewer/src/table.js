const collator = new Intl.Collator(undefined, { numeric: true });

export function tableRows(rows, search, sort) {
  const searchText = search.toLowerCase();
  const result = search
    ? rows.filter((row) =>
        Object.values(row).some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(searchText),
        ),
      )
    : sort
      ? [...rows]
      : rows;
  if (sort) {
    const { column, direction } = sort;
    result.sort(
      (a, b) =>
        (typeof a[column] === "number" && typeof b[column] === "number"
          ? a[column] - b[column]
          : collator.compare(
              String(a[column] ?? ""),
              String(b[column] ?? ""),
            )) * direction,
    );
  }
  return result;
}
