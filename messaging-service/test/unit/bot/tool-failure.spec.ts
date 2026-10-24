import { hasUnrecoveredToolFailure } from 'src/bot/router/tool-failure';

describe('hasUnrecoveredToolFailure', () => {
  it('no hay fallo sin llamadas', () => {
    expect(hasUnrecoveredToolFailure(undefined)).toBe(false);
    expect(hasUnrecoveredToolFailure([])).toBe(false);
  });

  it('un fallo que ninguna llamada posterior corrige cuenta como fallo', () => {
    expect(
      hasUnrecoveredToolFailure([
        { name: 'listar_tratamientos', ok: true },
        { name: 'crear_reserva_whatsapp', ok: false },
      ]),
    ).toBe(true);
  });

  it('un fallo seguido de un éxito de la misma herramienta queda corregido', () => {
    expect(
      hasUnrecoveredToolFailure([
        { name: 'disponibilidad_combo', ok: false },
        { name: 'listar_tratamientos', ok: true },
        { name: 'disponibilidad_combo', ok: true },
      ]),
    ).toBe(false);
  });

  it('un éxito seguido de un fallo de la misma herramienta cuenta como fallo', () => {
    expect(
      hasUnrecoveredToolFailure([
        { name: 'cancelar_reserva_whatsapp', ok: true },
        { name: 'cancelar_reserva_whatsapp', ok: false },
      ]),
    ).toBe(true);
  });

  it('corregir una herramienta no oculta el fallo de otra', () => {
    expect(
      hasUnrecoveredToolFailure([
        { name: 'disponibilidad_combo', ok: false },
        { name: 'disponibilidad_combo', ok: true },
        { name: 'crear_reserva_whatsapp', ok: false },
      ]),
    ).toBe(true);
  });

  describe('con herramientas de solo lectura', () => {
    const reads = new Set(['disponibilidad_combo', 'consultar_disponibilidad']);

    it('una consulta fallida queda resuelta si otra consulta posterior salió bien', () => {
      expect(
        hasUnrecoveredToolFailure(
          [
            { name: 'disponibilidad_combo', ok: false },
            { name: 'consultar_disponibilidad', ok: true },
          ],
          reads,
        ),
      ).toBe(false);
    });

    it('sin ninguna consulta posterior exitosa sigue siendo un fallo', () => {
      expect(
        hasUnrecoveredToolFailure(
          [
            { name: 'consultar_disponibilidad', ok: true },
            { name: 'disponibilidad_combo', ok: false },
          ],
          reads,
        ),
      ).toBe(true);
    });

    it('una acción fallida nunca se perdona por una consulta posterior', () => {
      expect(
        hasUnrecoveredToolFailure(
          [
            { name: 'crear_reserva_whatsapp', ok: false },
            { name: 'consultar_disponibilidad', ok: true },
          ],
          reads,
        ),
      ).toBe(true);
    });
  });
});
