export interface RestorableConnections {
  findConnectionsToRestore(): Promise<Array<{ id: string }>>;
}

export interface StartableSessions {
  start(connectionId: string): Promise<void>;
}

export interface RestoreLogger {
  log(message: string): void;
  error(message: string): void;
}

export async function restoreSessions(
  connections: RestorableConnections,
  sessions: StartableSessions,
  logger: RestoreLogger,
): Promise<{ started: number; failed: number }> {
  const toRestore = await connections.findConnectionsToRestore();

  const results = await Promise.all(
    toRestore.map(({ id }) =>
      sessions.start(id).then(
        () => true,
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          logger.error(
            `No se pudo restaurar la sesión de la conexión ${id}: ${reason}`,
          );
          return false;
        },
      ),
    ),
  );

  const started = results.filter(Boolean).length;
  const failed = results.length - started;
  logger.log(
    `Sesiones de WhatsApp restauradas: ${started} de ${results.length}` +
      (failed ? ` (${failed} con error)` : ''),
  );
  return { started, failed };
}
