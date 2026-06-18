-- ════════════════════════════════════════════════════════════════
--  task_manager — reverse-engineered schema (for local development)
--  Generated from server.js queries. Run against the task_manager DB.
-- ════════════════════════════════════════════════════════════════
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE task_manager;

-- USERS (password = bcrypt hash; login is by email; email UNIQUE)
CREATE TABLE IF NOT EXISTS users (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  name               VARCHAR(255)  NOT NULL,
  email              VARCHAR(255)  NOT NULL,
  notification_email VARCHAR(255)  DEFAULT '',
  password           VARCHAR(255)  NOT NULL,
  role               VARCHAR(50)   DEFAULT 'user',
  phone              VARCHAR(50)   DEFAULT NULL,
  department         VARCHAR(255)  DEFAULT '',
  week_off           VARCHAR(50)   DEFAULT '',
  extra_off          TEXT          DEFAULT NULL,
  profile_image      LONGTEXT      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
);

-- DELEGATION_TASKS
CREATE TABLE IF NOT EXISTS delegation_tasks (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  description        TEXT          DEFAULT NULL,
  assigned_to        INT           NOT NULL,
  assigned_by        INT           NOT NULL,
  due_date           DATE          DEFAULT NULL,
  status             VARCHAR(20)   DEFAULT 'pending',
  priority           VARCHAR(20)   DEFAULT 'low',
  approval           VARCHAR(10)   DEFAULT 'no',
  waiting_approval   TINYINT(1)    DEFAULT 0,
  remarks            TEXT          DEFAULT NULL,
  frequency          VARCHAR(20)   DEFAULT '',
  last_reminder_date DATE          DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_del_assigned_to (assigned_to),
  INDEX idx_del_due_date (due_date),
  INDEX idx_del_status (status)
);

-- CHECKLIST_TASKS
CREATE TABLE IF NOT EXISTS checklist_tasks (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  description TEXT          DEFAULT NULL,
  assigned_to INT           NOT NULL,
  assigned_by INT           NOT NULL,
  due_date    DATE          DEFAULT NULL,
  status      VARCHAR(20)   DEFAULT 'pending',
  priority    VARCHAR(20)   DEFAULT 'low',
  remarks     TEXT          DEFAULT NULL,
  frequency   VARCHAR(20)   DEFAULT '',
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chl_assigned_to (assigned_to),
  INDEX idx_chl_due_date (due_date),
  INDEX idx_chl_status (status),
  INDEX idx_chl_frequency (frequency)
);

-- TASK_APPROVALS (app never creates this)
CREATE TABLE IF NOT EXISTS task_approvals (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  task_id      INT           NOT NULL,
  task_type    VARCHAR(20)   NOT NULL,
  requested_by INT           NOT NULL,
  requested_to INT           NOT NULL,
  action_type  VARCHAR(20)   DEFAULT NULL,
  status       VARCHAR(20)   DEFAULT 'pending',
  note         TEXT          DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ta_task (task_id, task_type),
  INDEX idx_ta_requested_to (requested_to),
  INDEX idx_ta_status (status)
);

-- TASK_COMMENTS (app never creates this)
CREATE TABLE IF NOT EXISTS task_comments (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  task_id    INT           NOT NULL,
  task_type  VARCHAR(20)   NOT NULL,
  user_id    INT           NOT NULL,
  comment    TEXT          NOT NULL,
  created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tc_task (task_id, task_type)
);

-- FMS_SHEETS
CREATE TABLE IF NOT EXISTS fms_sheets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  fms_name    VARCHAR(255)  DEFAULT '',
  sheet_name  VARCHAR(255)  DEFAULT NULL,
  sheet_id    VARCHAR(255)  DEFAULT NULL,
  header_row  INT           DEFAULT 1,
  total_steps INT           DEFAULT 1,
  created_by  INT           DEFAULT NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fms_created_by (created_by)
);

-- FMS_STEPS
CREATE TABLE IF NOT EXISTS fms_steps (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  fms_id           INT           NOT NULL,
  step_order       INT           DEFAULT 0,
  step_name        VARCHAR(255)  DEFAULT NULL,
  plan_col         VARCHAR(10)   DEFAULT '',
  actual_col       VARCHAR(10)   DEFAULT '',
  extra_input      VARCHAR(10)   DEFAULT 'no',
  extra_col        VARCHAR(10)   DEFAULT '',
  show_cols        TEXT          DEFAULT NULL,
  delay_reason_col VARCHAR(10)   DEFAULT '',
  doer_name_col    VARCHAR(10)   DEFAULT '',
  INDEX idx_steps_fms (fms_id)
);

-- FMS_STEP_DOERS (app never creates this)
CREATE TABLE IF NOT EXISTS fms_step_doers (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  step_id INT NOT NULL,
  user_id INT NOT NULL,
  INDEX idx_fsd_step (step_id),
  INDEX idx_fsd_user (user_id)
);

-- FMS_EXTRA_ROWS
CREATE TABLE IF NOT EXISTS fms_extra_rows (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  step_id          INT           NOT NULL,
  row_label        VARCHAR(255)  DEFAULT '',
  col_letter       VARCHAR(10)   DEFAULT '',
  field_type       VARCHAR(20)   DEFAULT 'text',
  dropdown_options TEXT          DEFAULT NULL,
  INDEX idx_fer_step (step_id)
);

-- TASK_TRANSFERS (app also creates this on startup)
CREATE TABLE IF NOT EXISTS task_transfers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  task_id      INT NOT NULL,
  task_type    VARCHAR(20) NOT NULL,
  from_user    INT NOT NULL,
  to_user      INT NOT NULL,
  requested_by INT NOT NULL,
  status       ENUM('pending','approved','rejected') DEFAULT 'pending',
  note         TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- WEEK_PLANS (app also creates this on startup)
CREATE TABLE IF NOT EXISTS week_plans (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  employee_id     INT NOT NULL,
  hod_id          INT NOT NULL,
  start_date      DATE NOT NULL,
  target_count    INT DEFAULT 0,
  improvement_pct INT DEFAULT NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emp_week (employee_id, start_date),
  INDEX idx_start_date (start_date),
  INDEX idx_employee (employee_id)
);
