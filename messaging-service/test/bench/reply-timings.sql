select
  to_char(o."createdAt" at time zone 'America/Bogota', 'HH24:MI:SS') as hora_respuesta_lista,
  right(o."phoneNumber", 4) as chat,
  length(o.content) as caracteres,
  round(extract(epoch from (o."createdAt" - i."createdAt"))::numeric, 1) as espera_mas_ia_s,
  round(extract(epoch from (o."sentAt" - o."createdAt"))::numeric, 1) as cola_mas_escribiendo_s,
  round(extract(epoch from (o."sentAt" - i."createdAt"))::numeric, 1) as total_s,
  o.status::text as estado
from "OutboundReply" o
left join lateral (
  select m."createdAt"
  from "BotMessage" m
  where m."conversationId" = o."conversationId"
    and m.direction = 'INBOUND'
    and m."createdAt" <= o."createdAt"
  order by m."createdAt" desc
  limit 1
) i on true
where o.seq = 0
order by o."createdAt" desc
limit 20;
