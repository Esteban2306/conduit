# Banco de conversaciones (Conduit + Leonice)

Mide el bot de punta a punta con el ruteo real de Conduit y el backend real de Leonice. Lo hace sobre infraestructura propia y sin WhatsApp.

```bash
pnpm bench:baseline
```

Requisitos: Docker, el repo de Leonice en `../../leonice_spa_backend` (o `BENCH_LEONICE_ROOT`) con dependencias instaladas, y la base de desarrollo de Conduit accesible. De esa base se lee, en modo solo lectura, la configuración del bot de producción.

## Qué hace

1. Levanta (o reutiliza) `conduit-bench-pg` (127.0.0.1:55433) y `conduit-bench-redis` (127.0.0.1:56390).
2. Recrea las bases `conduit_bench` y `leonice_bench`, aplica las migraciones de ambos repos y siembra el catálogo real de Leonice (`prisma/seed.ts` y `prisma/seed-treatment-content.ts`).
3. Arranca Conduit **dentro del proceso** con `Test.createTestingModule(AppModule)`:
   - Reemplaza `BaileysSessionManager` por un doble sin socket.
   - Reemplaza `BaileysPlugin`, `GmailResendPlugin` y `SmtpPlugin` por un *fake sender* que registra lo que se enviaría.
   - Copia del bot de producción (`ea6cf0a6…`): `BotConfig`, herramientas, modelo, ajustes, plantillas y contactos de escalamiento. Las URLs de las herramientas se reescriben hacia el Leonice de pruebas.
4. Arranca Leonice desde el código fuente (`leonice_spa_backend/test/bench/leonice-bench-server.ts`):
   - con su doble de Cloudinary;
   - con plantillas de Conduit sembradas por `seed-conduit-templates`;
   - con rutas `/__bench/state` y `/__bench/inspect` para sembrar e inspeccionar el estado previo.
5. Ejecuta `scenarios.json`. Inyecta cada mensaje por `BotRouter.route()`, el mismo punto de entrada que usa Baileys, y espera a que el turno termine.
6. Escribe `results/<fecha>/results.json`, `summary.md`, `conduit.log` y `leonice.log`.

## Aislamiento

- Cada proceso recibe un entorno explícito: toda clave del `.env` de cada repo se sobrescribe con un valor del banco o con `bench-disabled`. Así Prisma no completa variables desde tu `.env` (por ejemplo `CONDUIT_BASE_URL` o `REDIS_URL` reales).
- El servidor de Leonice aborta si la base no es `leonice_bench`, si Redis no es el de pruebas o si Conduit no es local.
- No se conecta ningún WhatsApp ni se envía ningún correo: todo envío queda en el *fake sender*.
- La única llamada externa es al proveedor del modelo (Anthropic), con la key del bot, que no se imprime. Hay un tope de gasto: `BENCH_BUDGET_USD`, 0,50 por defecto.

## Variables

| Variable | Defecto | Uso |
|---|---|---|
| `BENCH_ONLY` | todas | ids separados por coma (`b01,b16`) |
| `BENCH_BUDGET_USD` | 0.5 | corta las llamadas al modelo al superar el gasto |
| `BENCH_CONNECTIONS` | 4 | conversaciones en paralelo (una conexión simulada por trabajador) |
| `BENCH_KEEP_SOURCE_LIMITS` | false | `true` conserva el tope diario y por minuto del modelo de producción |
| `BENCH_PG_PORT`, `BENCH_REDIS_PORT`, `BENCH_CONDUIT_PORT`, `BENCH_LEONICE_PORT` | 55433, 56390, 4931, 3931 | puertos propios |

Para borrar la infraestructura: `docker rm -f conduit-bench-pg conduit-bench-redis`.

## Diferencias con producción (a tener en cuenta al leer números)

- El *fake sender* no pasa por `BaileysRateLimiter` ni simula "escribiendo…". La latencia medida es: debounce + IA + herramientas.
- Por defecto se quita el tope diario (400.000 tokens) y el tope por minuto (20) del modelo. Si no, el banco se queda sin IA a mitad de la corrida. Con `BENCH_KEEP_SOURCE_LIMITS=true` se reproduce ese corte.
- `BusinessSettings` de Leonice lleva valores ficticios (anticipo 50, instrucciones y dirección de prueba). En la base de desarrollo están vacíos.
- Las conversaciones paralelas usan conexiones distintas. Así el error de mezcla de chats (C1) solo aparece en el caso que lo prueba (`b38`), con dos clientas en la misma conexión.
- La descarga de imágenes falla a propósito (no hay WhatsApp). Es el mismo resultado que ve una herramienta que exige imagen cuando la descarga falla.

## Formato de `scenarios.json`

- `prior`: clienta y reservas que se siembran en Leonice antes de empezar.
- `turns[]`:
  - `actor` (A, B…);
  - `messages[]`: `text`, `sticker`, `audio`, `reaction` o `image.caption`;
  - `concurrentWithPrevious`;
  - `expect.route`: `IA`, `directo`, `ignorado` o `acuse`. `acuse` aplica la regla del producto: se ignora salvo que la última respuesta del bot tenga una pregunta.
- `expect`:
  - `toolsAny`, `toolsAll`, `toolsForbidden` (herramientas pedidas por el modelo o ejecutadas);
  - `replyMatches`, `replyNotMatches`;
  - `finalState.reservationStatus`, `finalState.reservationCountAtLeast`;
  - `noFalseHumanPromise`, `notCutOrEmpty`, `noCrossTalk`, `everyActorAnswered`.
- `knownFailure`: el caso debe fallar hoy (C1, A1, A2, C3). El resumen informa si se reprodujo.

Banderas por turno:
- `cortado`: `stop_reason = max_tokens`.
- `vacío`: el envío solo tiene espacios o caracteres invisibles.
- `sin-respuesta`.
- `genérico-por-herramienta`: el texto de "tuvimos un inconveniente".
- `ia-no-disponible`.
- `fecha-desconocida`.
- `promesa-falsa`: promete una persona y nadie del equipo fue avisado.
- `timeout`.

Rutas: `IA` (llamó al modelo), `directo` (respondió sin modelo: aviso de IA caída, tope de abuso), `ignorado` (no respondió) y `plantilla` (aún no existe en el producto; queda en 0).
