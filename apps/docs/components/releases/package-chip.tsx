/** A package and its version as one mono chip: `turno-cli 0.2.0`. */
export function PackageChip({ name, version }: { name: string; version: string }) {
  return (
    <span className="d-chip">
      <span>{name}</span>
      <span className="d-chip-version">{version}</span>
    </span>
  );
}
