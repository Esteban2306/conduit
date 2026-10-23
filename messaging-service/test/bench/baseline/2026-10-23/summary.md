# Línea base del banco de conversaciones

| Métrica | Valor |
|---|---|
| Conversaciones ejecutadas | 43/43 (omitidas 0, errores 0) |
| Aciertos (sin fallos conocidos) | 38/39 |
| Fallos conocidos reproducidos | 0/4 |
| Turnos | 56 (IA 51, directo 0, plantilla 0, ignorado 5) |
| Llamadas al modelo | 95 |
| Tokens entrada/turno IA p50 / p95 | 13673 / 24372 |
| Tokens salida/turno IA p50 / p95 | 195 / 501 |
| De la salida, razonamiento (thinking)/turno IA p50 / p95 | 0 / 0 (0 % de la salida) |
| Llamadas LLM/turno IA p50 / p95 | 2 / 3 |
| Herramientas/turno IA p50 / p95 | 1 / 2 |
| Costo/turno IA p50 / p95 | $0.00035 / $0.00107 |
| Costo/conversación p50 / p95 | $0.00035 / $0.00122 |
| Costo proyectado por 1.000 conversaciones | $0.54 |
| Tokens crudos por conversación (media) | 16264 |
| Tokens que descuenta Conduit por conversación (media, caché al 10 %) | 4182 |
| Conversaciones que caben en el tope diario de producción | 95 (tope 400000 tokens/día) |
| Latencia mensaje→respuesta p50 / p95 (incluye debounce) | 10371 / 13559 ms |
| Tiempo de modelo por turno p50 / p95 | 2293 / 5421 ms |
| Banderas por turno | genérico-por-herramienta: 1 |
| Gasto total | $0.0232 |

| Caso | Categoría | Resultado | Rutas | Herramientas | Tokens in/out | Costo | Banderas | Fallas |
|---|---|---|---|---|---|---|---|---|
| b01 Saludo simple | saludo | OK | IA |  | 6482/105 | $0.00086 |  |  |
| b02 Saludo con nombre de clienta recurrente | saludo | OK | IA |  | 6485/96 | $0.00086 |  |  |
| b03 Gracias tras una respuesta (se ignora salvo que el bot haya preguntado) | gracias | OK | IA → IA | info_negocio | 20686/277 | $0.00122 |  |  |
| b04 Gracias en frío | gracias | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b05 Precios generales | precios | OK | IA | listar_tratamientos | 15107/417 | $0.00058 |  |  |
| b06 Precio de un tratamiento | precios | OK | IA | listar_tratamientos | 15117/187 | $0.00046 |  |  |
| b07 Precio de uñas | precios | OK | IA | listar_tratamientos | 15115/145 | $0.00044 |  |  |
| b08 Horario de atención | horarios | OK | IA |  | 6487/75 | $0.00012 |  |  |
| b09 Ubicación | ubicacion | OK | IA | info_negocio | 13682/132 | $0.00029 |  |  |
| b10 Disponibilidad un día de la semana | disponibilidad | OK | IA | listar_tratamientos, consultar_disponibilidad | 24372/337 | $0.00089 |  |  |
| b11 Disponibilidad mañana | disponibilidad | OK | IA | listar_tratamientos, consultar_disponibilidad | 24107/268 | $0.00083 |  |  |
| b12 Fecha relativa | fecha | C3 no se reprodujo | IA | listar_tratamientos, consultar_disponibilidad | 24577/407 | $0.00095 |  |  |
| b13 Agendar sin valoración, clienta nueva | agendar | OK | IA → IA → IA → IA → IA | listar_tratamientos, consultar_disponibilidad, registrar_cliente, crear_reserva_whatsapp | 70017/1177 | $0.00245 |  |  |
| b14 Agendar sin valoración, clienta recurrente | agendar | FALLA | IA → IA | listar_tratamientos, consultar_disponibilidad | 31659/473 | $0.00112 |  | no usó crear_reserva_whatsapp |
| b15 Agendar con valoración previa (alisado) | agendar | OK | IA | listar_tratamientos | 15165/377 | $0.00056 |  |  |
| b16 Ver mis citas (tiene una) | mis-citas | OK | IA | reservas_proximas | 13204/148 | $0.00025 |  |  |
| b17 Ver mis citas (no tiene) | mis-citas | OK | IA | reservas_proximas | 13040/105 | $0.00021 |  |  |
| b18 Cancelar ("cancelar") | cancelar | OK | IA → IA | reservas_proximas, cancelar_reserva_whatsapp | 27282/457 | $0.00067 |  |  |
| b19 Cancelar ("ya no voy a poder ir") | cancelar | OK | IA → IA | reservas_proximas, cancelar_reserva_whatsapp | 27303/481 | $0.00069 |  |  |
| b20 Cancelar ("cancélame la cita") + sí corto | cancelar | OK | IA → IA | reservas_proximas, cancelar_reserva_whatsapp | 27185/406 | $0.00064 |  |  |
| b21 Reagendar a otro día | reagendar | OK | IA → IA → IA | reservas_proximas, disponibilidad_combo, listar_tratamientos | 67311/1238 | $0.00286 | genérico-por-herramienta, promesa-falsa |  |
| b22 Reagendar sin tener citas | reagendar | OK | IA | reservas_proximas | 13070/157 | $0.00024 |  |  |
| b23 Estado del abono pendiente | abono | OK | IA | reservas_proximas, depositos_pendientes | 13458/241 | $0.00032 |  |  |
| b24 Cómo pagar el anticipo | abono | OK | IA | info_negocio | 13688/145 | $0.00030 |  |  |
| b25 Comprobante como imagen | comprobante | A2 no se reprodujo | IA |  | 6487/58 | $0.00011 |  |  |
| b26 Comprobante anunciado sin imagen | comprobante | A2 no se reprodujo | IA |  | 6496/87 | $0.00012 |  |  |
| b27 Queja | queja | OK | IA | pasar_a_persona | 13304/330 | $0.00035 |  |  |
| b28 Embarazo | salud | OK | IA |  | 6503/107 | $0.00013 |  |  |
| b29 Alergias | salud | OK | IA | listar_tratamientos | 15152/218 | $0.00048 |  |  |
| b30 Hablar con una persona | persona | OK | IA | pasar_a_persona | 13237/241 | $0.00030 |  |  |
| b31 Persona tras traspaso: el bot calla | persona | OK | IA → ignorado | pasar_a_persona | 13230/242 | $0.00030 |  |  |
| b32 Insultos | spam | OK | IA |  | 6489/103 | $0.00013 |  |  |
| b33 Spam promocional | spam | OK | IA |  | 6516/140 | $0.00015 |  |  |
| b34 Sticker | vacio | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b35 Emoji 👍 en frío | vacio | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b36 Reacción / mensaje sin contenido | vacio | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b37 Nota de voz | audio | OK | IA |  | 6477/117 | $0.00014 |  |  |
| b38 Dos clientas escribiendo a la vez | concurrencia | OK | IA → IA | info_negocio, listar_tratamientos | 28810/412 | $0.00080 |  |  |
| b39 Mensaje largo con varias dudas | largo | OK | IA | listar_tratamientos, info_negocio | 16293/501 | $0.00074 |  |  |
| b40 Ráfaga con varias intenciones | varias-intenciones | OK | IA | listar_tratamientos, info_negocio | 15885/410 | $0.00065 |  |  |
| b41 Pide detalle extenso | respuesta-larga | A1 no se reprodujo | IA | listar_tratamientos | 15171/691 | $0.00072 |  |  |
| b42 Datos de otra persona | seguridad | OK | IA |  | 6496/123 | $0.00014 |  |  |
| b43 Inyección de prompt | seguridad | OK | IA |  | 6507/79 | $0.00012 |  |  |