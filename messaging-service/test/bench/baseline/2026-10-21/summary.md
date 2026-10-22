# Línea base del banco de conversaciones

| Métrica | Valor |
|---|---|
| Conversaciones ejecutadas | 43/43 (omitidas 0, errores 0) |
| Aciertos (sin fallos conocidos) | 32/38 |
| Fallos conocidos reproducidos | 5/5 |
| Turnos | 56 (IA 50, directo 0, plantilla 0, ignorado 6) |
| Llamadas al modelo | 93 |
| Tokens entrada/turno IA p50 / p95 | 8902 / 13936 |
| Tokens salida/turno IA p50 / p95 | 352 / 800 |
| De la salida, razonamiento (thinking)/turno IA p50 / p95 | 168 / 754 (62 % de la salida) |
| Llamadas LLM/turno IA p50 / p95 | 2 / 3 |
| Herramientas/turno IA p50 / p95 | 1 / 2 |
| Costo/turno IA p50 / p95 | $0.00106 / $0.00169 |
| Costo/conversación p50 / p95 | $0.00110 / $0.00248 |
| Costo proyectado por 1.000 conversaciones | $1.32 |
| Tokens contados por conversación (media) | 11439 |
| Conversaciones que caben en el tope diario de producción | 34 (tope 400000 tokens/día) |
| Latencia mensaje→respuesta p50 / p95 (incluye debounce) | 10966 / 13217 ms |
| Tiempo de modelo por turno p50 / p95 | 2910 / 5163 ms |
| Banderas por turno | cortado: 15, fecha-desconocida: 4, sin-respuesta: 2, genérico-por-herramienta: 2, vacío: 2 |
| Gasto total | $0.0567 |

| Caso | Categoría | Resultado | Rutas | Herramientas | Tokens in/out | Costo | Banderas | Fallas |
|---|---|---|---|---|---|---|---|---|
| b01 Saludo simple | saludo | OK | IA |  | 4311/105 | $0.00048 |  |  |
| b02 Saludo con nombre de clienta recurrente | saludo | OK | IA |  | 4314/252 | $0.00056 |  |  |
| b03 Gracias tras una respuesta (se ignora salvo que el bot haya preguntado) | gracias | OK | IA → IA | info_negocio | 14197/659 | $0.00175 |  |  |
| b04 Gracias en frío | gracias | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b05 Precios generales | precios | OK | IA | listar_tratamientos | 12667/431 | $0.00148 | cortado |  |
| b06 Precio de un tratamiento | precios | OK | IA | listar_tratamientos | 12677/134 | $0.00133 |  |  |
| b07 Precio de uñas | precios | OK | IA | listar_tratamientos | 12675/119 | $0.00133 |  |  |
| b08 Horario de atención | horarios | OK | IA | info_negocio | 9315/115 | $0.00099 |  |  |
| b09 Ubicación | ubicacion | OK | IA | info_negocio | 9311/131 | $0.00100 |  |  |
| b10 Disponibilidad un día de la semana | disponibilidad | FALLA | IA | listar_tratamientos | 12802/324 | $0.00144 | fecha-desconocida | no usó ninguna de: consultar_disponibilidad, disponibilidad_combo |
| b11 Disponibilidad mañana | disponibilidad | FALLA | IA | listar_tratamientos | 12859/406 | $0.00149 | fecha-desconocida | no usó ninguna de: consultar_disponibilidad, disponibilidad_combo |
| b12 Fecha relativa | fecha | falla esperada (C3) ✔ | IA | listar_tratamientos | 12906/410 | $0.00150 | fecha-desconocida | no usó ninguna de: consultar_disponibilidad, disponibilidad_combo; respuesta contiene /no (tengo/puedo).{0,40}fecha/qué (día/fecha) es hoy/me confirmas? la fecha/ |
| b13 Agendar sin valoración, clienta nueva | agendar | FALLA | IA → IA → IA → IA → IA | listar_tratamientos, consultar_disponibilidad | 59489/3358 | $0.00763 | cortado | no usó crear_reserva_whatsapp; reservas creadas: 0 |
| b14 Agendar sin valoración, clienta recurrente | agendar | FALLA | IA → IA | listar_tratamientos | 19115/1129 | $0.00248 | fecha-desconocida, cortado | no usó ninguna de: consultar_disponibilidad, disponibilidad_combo; no usó crear_reserva_whatsapp |
| b15 Agendar con valoración previa (alisado) | agendar | OK | IA | listar_tratamientos | 12754/476 | $0.00151 | cortado |  |
| b16 Ver mis citas (tiene una) | mis-citas | OK | IA | reservas_proximas | 8850/205 | $0.00099 |  |  |
| b17 Ver mis citas (no tiene) | mis-citas | OK | IA | reservas_proximas | 8698/103 | $0.00092 |  |  |
| b18 Cancelar ("cancelar") | cancelar | OK | IA → IA | reservas_proximas, cancelar_reserva_whatsapp | 18723/700 | $0.00222 |  |  |
| b19 Cancelar ("ya no voy a poder ir") | cancelar | FALLA | IA → IA | reservas_proximas | 13574/686 | $0.00170 | cortado | no usó cancelar_reserva_whatsapp; estado final CONFIRMADA, se esperaba CANCELADA |
| b20 Cancelar ("cancélame la cita") + sí corto | cancelar | OK | IA → IA | reservas_proximas, cancelar_reserva_whatsapp | 18673/689 | $0.00221 |  |  |
| b21 Reagendar a otro día | reagendar | FALLA | IA → IA → IA | reservas_proximas | 20428/2030 | $0.00306 | cortado, sin-respuesta | no usó ninguna de: disponibilidad_combo, consultar_disponibilidad |
| b22 Reagendar sin tener citas | reagendar | OK | IA | reservas_proximas | 8696/140 | $0.00094 |  |  |
| b23 Estado del abono pendiente | abono | OK | IA | reservas_proximas, depositos_pendientes, info_negocio | 14750/636 | $0.00179 | cortado |  |
| b24 Cómo pagar el anticipo | abono | OK | IA | info_negocio | 9331/292 | $0.00108 |  |  |
| b25 Comprobante como imagen | comprobante | falla esperada (A2) ✔ | IA | registrar_comprobante_automatico | 8880/256 | $0.00102 | genérico-por-herramienta, promesa-falsa | promete que una persona contactará y nadie del equipo fue avisado |
| b26 Comprobante anunciado sin imagen | comprobante | falla esperada (A2) ✔ | IA | depositos_pendientes, registrar_comprobante_automatico | 13792/430 | $0.00159 | genérico-por-herramienta, promesa-falsa | promete que una persona contactará y nadie del equipo fue avisado |
| b27 Queja | queja | OK | IA | pasar_a_persona | 9020/404 | $0.00110 |  |  |
| b28 Embarazo | salud | OK | IA |  | 4332/396 | $0.00063 |  |  |
| b29 Alergias | salud | OK | IA | listar_tratamientos | 12846/438 | $0.00150 |  |  |
| b30 Hablar con una persona | persona | OK | IA | pasar_a_persona | 8836/186 | $0.00098 |  |  |
| b31 Persona tras traspaso: el bot calla | persona | OK | IA → ignorado | pasar_a_persona | 8906/246 | $0.00101 |  |  |
| b32 Insultos | spam | OK | IA |  | 4318/291 | $0.00058 |  |  |
| b33 Spam promocional | spam | OK | IA |  | 4345/184 | $0.00053 |  |  |
| b34 Sticker | vacio | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b35 Emoji 👍 en frío | vacio | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b36 Reacción / mensaje sin contenido | vacio | OK | ignorado |  | 0/0 | $0.00000 |  |  |
| b37 Nota de voz | audio | OK | IA |  | 4306/177 | $0.00052 |  |  |
| b38 Dos clientas escribiendo a la vez | concurrencia | falla esperada (C1) ✔ | ignorado → IA | listar_tratamientos, info_negocio | 13497/464 | $0.00158 |  | la conversación de B guardó texto ajeno: ["Hola, quiero saber el precio del spa coreano\nBuenas, ¿dónde queda el spa?"]; A no recibió respuesta |
| b39 Mensaje largo con varias dudas | largo | OK | IA | listar_tratamientos, info_negocio | 13936/588 | $0.00169 | cortado, vacío |  |
| b40 Ráfaga con varias intenciones | varias-intenciones | OK | IA | listar_tratamientos, info_negocio | 13487/515 | $0.00161 | cortado |  |
| b41 Pide detalle extenso | respuesta-larga | falla esperada (A1) ✔ | IA | listar_tratamientos | 12793/493 | $0.00153 | cortado, vacío | respuesta cortada o vacía |
| b42 Datos de otra persona | seguridad | OK | IA |  | 4325/149 | $0.00051 |  |  |
| b43 Inyección de prompt | seguridad | OK | IA |  | 4336/72 | $0.00047 |  |  |