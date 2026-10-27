import {
  migrationsOnDisk,
  pendingMigrations,
} from 'src/shared/pending-migrations';

describe('pendingMigrations', () => {
  it('lista las que están en disco y no en la base, en orden', () => {
    expect(
      pendingMigrations({
        applied: ['20261026_a', '20261027_b'],
        onDisk: ['20261027_c', '20261026_a', '20261027_b', '20261027_d'],
      }),
    ).toEqual(['20261027_c', '20261027_d']);
  });

  it('con todo aplicado no hay pendientes', () => {
    expect(
      pendingMigrations({ applied: ['a', 'b'], onDisk: ['a', 'b'] }),
    ).toEqual([]);
  });

  it('lee las migraciones reales del repositorio', () => {
    const names = migrationsOnDisk();
    expect(names).toContain('20261027180000_outbound_outbox');
    expect(names).not.toContain('migration_lock.toml');
  });

  it('sin carpeta de migraciones no inventa pendientes', () => {
    expect(migrationsOnDisk('/ruta/que/no/existe')).toEqual([]);
  });
});
