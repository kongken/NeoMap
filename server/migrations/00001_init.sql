-- 第一阶段表结构：用户、第三方身份、行程（假期 + 机场快照 + 航段）。
-- 设计说明见 docs/backend-phase1-design.md 第 5 节。

-- +goose Up
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  display_name  text NOT NULL,
  email         text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  provider          text NOT NULL,
  provider_user_id  text NOT NULL,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

-- 全局递增的变更序号，用作增量同步游标。
-- 同一用户的写入在事务内先锁定 users 行，保证提交顺序与取号顺序一致（设计文档 6.2）。
CREATE SEQUENCE trip_change_seq;

CREATE TABLE trips (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  start_date         date,
  end_date           date,
  notes              text CHECK (char_length(notes) <= 1000),
  is_sample          boolean NOT NULL DEFAULT false,
  revision           bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  change_seq         bigint NOT NULL DEFAULT nextval('trip_change_seq'),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  server_updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX trips_user_change_seq_idx ON trips (user_id, change_seq);
CREATE INDEX trips_deleted_at_idx ON trips (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE trip_airports (
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  airport_id    text NOT NULL,
  iata          char(3) NOT NULL CHECK (iata ~ '^[A-Z]{3}$'),
  name          text NOT NULL,
  name_zh       text,
  city          text,
  city_zh       text,
  aliases       text[],
  country_code  text NOT NULL,
  country_name  text,
  latitude      double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude     double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  PRIMARY KEY (trip_id, airport_id)
);

CREATE TABLE flight_legs (
  id                    uuid PRIMARY KEY,
  trip_id               uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ord                   integer NOT NULL CHECK (ord >= 0),
  departure_airport_id  text NOT NULL,
  arrival_airport_id    text NOT NULL,
  departure_date        date NOT NULL,
  flight_number         text CHECK (char_length(flight_number) <= 12),
  airline               text CHECK (char_length(airline) <= 60),
  notes                 text CHECK (char_length(notes) <= 1000),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  CONSTRAINT flight_legs_trip_ord_key UNIQUE (trip_id, ord) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT flight_legs_departure_fk FOREIGN KEY (trip_id, departure_airport_id) REFERENCES trip_airports (trip_id, airport_id),
  CONSTRAINT flight_legs_arrival_fk FOREIGN KEY (trip_id, arrival_airport_id) REFERENCES trip_airports (trip_id, airport_id),
  CHECK (departure_airport_id <> arrival_airport_id)
);
CREATE INDEX flight_legs_trip_id_idx ON flight_legs (trip_id);

-- +goose Down
DROP TABLE flight_legs;
DROP TABLE trip_airports;
DROP TABLE trips;
DROP SEQUENCE trip_change_seq;
DROP TABLE user_identities;
DROP TABLE users;
