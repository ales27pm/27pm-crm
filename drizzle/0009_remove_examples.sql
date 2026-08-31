-- Retire uniquement les scénarios de validation connus. Les cinq comptes,
-- dossiers et tâches issus de la cohorte utilisateur restent intacts.
DELETE FROM `message_events`
WHERE `id` IN (
  '1f6c73e8-24b9-4832-8e8e-072299c273e2',
  '2954bfb9-2f16-4387-bf80-d62c7186ff6c',
  '334629f5-a839-499d-bd96-958e58e77eca',
  '3d8a35b1-b7e4-4261-b75a-8d5b9e40fa60',
  '574835f7-ea1d-4114-8e03-60231b93e836',
  '76c57942-bb5e-4357-8978-959ed3722701',
  '82946545-640b-4cc2-ba21-00ad0fa73339',
  'bb881a84-20ff-4501-97ea-c01d00e0ce55',
  'bc39a654-9ac1-4c01-9af0-c58df4f26a15',
  'c2a679a2-900f-40d4-9351-cc99889af1b6',
  'cf543777-7e2d-4a29-a5e1-81f97231b2b3'
);--> statement-breakpoint

DELETE FROM `send_commands`
WHERE `id` IN (
  '571365bc-11f6-45a5-bf8a-3f4fcc5598b3',
  'cdaf0c97-b52c-4168-b1a5-7edb9fbfbc76',
  'fdaf4f1d-db2e-443c-868e-cf02059bd5ab'
);--> statement-breakpoint

DELETE FROM `attachments`
WHERE `message_id` IN (
  '22d726bc-c83e-4d3c-8915-5bbfa96d1afa',
  '7fa2f341-e5ee-44eb-82c4-71cd41a2896b',
  '9a06b339-7d67-4f07-9517-2b7b405d330c',
  'b2eb54d2-254e-412c-a891-e112c0a7787c',
  'b8ca33ff-0401-4912-88b1-77ed0125c884',
  'd043df9d-a394-4a06-8af8-77d7901afcd0'
);--> statement-breakpoint

DELETE FROM `messages`
WHERE `id` IN (
  '22d726bc-c83e-4d3c-8915-5bbfa96d1afa',
  '7fa2f341-e5ee-44eb-82c4-71cd41a2896b',
  '9a06b339-7d67-4f07-9517-2b7b405d330c',
  'b2eb54d2-254e-412c-a891-e112c0a7787c',
  'b8ca33ff-0401-4912-88b1-77ed0125c884',
  'd043df9d-a394-4a06-8af8-77d7901afcd0'
);--> statement-breakpoint

DELETE FROM `conversations`
WHERE `id` IN (
  '074b26ef-9fdf-45da-88c1-61ab8b66c750',
  '39402253-ccfb-4b12-9a3d-dea87623666b',
  'da251784-962d-467a-b156-d2a70aa5fac9',
  'ee8d1856-54bc-4ade-89fd-b34a946caaae'
);--> statement-breakpoint

DELETE FROM `contact_channel_compliance`
WHERE `contact_id` IN (
  '20a00a7b-f781-4292-9cbe-0d665a77c9b4',
  'e8bb2c94-054e-4cc1-8c0d-8a1f623bc0fe'
);--> statement-breakpoint

DELETE FROM `contacts`
WHERE `id` IN (
  '20a00a7b-f781-4292-9cbe-0d665a77c9b4',
  'e8bb2c94-054e-4cc1-8c0d-8a1f623bc0fe'
);--> statement-breakpoint

DELETE FROM `intake_rate_limits`
WHERE `bucket_key` =
  '5710fcc1b8906c8bffd9831066d732da58ba1cae1a840875abb2eb8480191ece:1788138000000';--> statement-breakpoint

DELETE FROM `intake_submissions`
WHERE `id` = '4584286f-68a1-45b4-9e45-3bda5c92b7c8';--> statement-breakpoint

DELETE FROM `webhook_receipts`
WHERE `callback_key` IN (
  'event:7f_AXLD5RqOoZNBMDQkhGg',
  'event:UJS-DAYvRhyG9rbeRn4puA',
  'inbound:sa1pr14mb742317676df4a21d0b170d32ccac2@sa1pr14mb7423.namprd14.prod.outlook.com',
  'event:JzkosW09Q96nz0HFgbGunw',
  'event:Z3BBmSRNSUW7X7NyW1MB3w',
  'inbound:sa1pr14mb74232342f95909657719b7ddccac2@sa1pr14mb7423.namprd14.prod.outlook.com',
  'event:dL48zXNDS1CrLYp78wRA1w',
  'event:HLiHFxDuSN29foHuLLhcdw',
  'event:8FpdfzElQt2P1wWZHelOYQ',
  'event:4o2Z-HutTj-anLkb0pKTUA',
  'event:XCPwM1Z5RjGHvkW9he9kGg',
  'event:f056ZorkT924yuyZQ3RG2A',
  'inbound:f23b564c41ba3fae3740f3235473ef2b72937d8b-10024494-110966705@google.com',
  'event:BY3Cof4SSo2WMuN47I7lZg'
);--> statement-breakpoint
