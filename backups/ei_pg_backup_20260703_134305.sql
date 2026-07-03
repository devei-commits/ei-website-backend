--
-- PostgreSQL database dump
--

\restrict mBJ89pH7jDeqzW3XzVq1qJYaqSOFyROtIBJ6L6L9J5LcgoTWpIKsx2OaneFZdMO

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: enum_orders_fulfillment_stage; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_orders_fulfillment_stage AS ENUM (
    'pending',
    'in_development',
    'in_production',
    'completed_production',
    'packaged',
    'invoiced',
    'shipped'
);


--
-- Name: enum_orders_order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_orders_order_status AS ENUM (
    'pending',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded'
);


--
-- Name: enum_orders_payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_orders_payment_status AS ENUM (
    'pending',
    'paid',
    'failed',
    'refunded'
);


--
-- Name: enum_payments_gateway; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_payments_gateway AS ENUM (
    'razorpay',
    'cheque',
    'cod',
    'wallet'
);


--
-- Name: enum_payments_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_payments_status AS ENUM (
    'pending',
    'completed',
    'failed',
    'refunded'
);


--
-- Name: enum_permissions_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_permissions_action AS ENUM (
    'view',
    'create',
    'edit',
    'delete'
);


--
-- Name: enum_production_equipment_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_production_equipment_category AS ENUM (
    'manufacturing',
    'filling',
    'packaging'
);


--
-- Name: enum_production_team_members_department; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_production_team_members_department AS ENUM (
    'Manufacturing',
    'Filling',
    'Packaging',
    'Quality'
);


--
-- Name: enum_staff_profiles_department; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_staff_profiles_department AS ENUM (
    'sales',
    'rnd',
    'quality_assurance',
    'logistics',
    'marketing',
    'finance'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addresses (
    address_id integer NOT NULL,
    user_id integer NOT NULL,
    address_type character varying(255),
    is_default_shipping boolean DEFAULT false,
    is_default_billing boolean DEFAULT false,
    first_name character varying(255),
    last_name character varying(255),
    address_line1 character varying(255) NOT NULL,
    address_line2 character varying(255),
    landmark character varying(255),
    city_text character varying(255),
    state_text character varying(255),
    country_text character varying(255),
    pincode character varying(255),
    updated_at timestamp with time zone,
    phone character varying(255),
    email character varying(255),
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: addresses_address_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.addresses_address_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: addresses_address_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.addresses_address_id_seq OWNED BY public.addresses.address_id;


--
-- Name: appointments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointments (
    appointmentid integer NOT NULL,
    app_id character varying(255),
    app_type character varying(255),
    app_doc_name character varying(255),
    app_doc_mobile character varying(255),
    app_doc_email character varying(255),
    app_clinic_name character varying(255),
    app_address1 character varying(255),
    app_address2 character varying(255),
    app_state character varying(255),
    app_city character varying(255),
    app_other_address character varying(255),
    app_pincode character varying(255),
    app_date1 character varying(255),
    app_date1_time_slot1 character varying(255),
    app_date2 character varying(255),
    app_date2_time_slot2 character varying(255),
    app_status character varying(255),
    app_remarks character varying(255),
    app_userid character varying(255),
    confirm_appointment character varying(255),
    app_confirmation_status character varying(255),
    meeting_status character varying(255),
    mom character varying(255),
    assign_to character varying(255),
    pex_id character varying(255),
    adedon character varying(255),
    user_id integer,
    doctor_id character varying(255),
    clinic_name character varying(255),
    email character varying(255),
    phone character varying(255),
    address text,
    city character varying(255),
    state character varying(255),
    pincode character varying(255),
    reason text,
    mode character varying(255),
    status character varying(255),
    slot1_date date,
    slot1_time time without time zone,
    slot2_date date,
    slot2_time time without time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: appointments_appointmentid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appointments_appointmentid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appointments_appointmentid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.appointments_appointmentid_seq OWNED BY public.appointments.appointmentid;


--
-- Name: authentication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authentication (
    id integer NOT NULL,
    user_id integer NOT NULL,
    phone character varying(255) NOT NULL,
    otp character varying(255) NOT NULL,
    expired timestamp with time zone NOT NULL,
    created timestamp with time zone NOT NULL
);


--
-- Name: authentication_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.authentication_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: authentication_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.authentication_id_seq OWNED BY public.authentication.id;


--
-- Name: bd_client_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_client_profiles (
    id integer NOT NULL,
    client_id integer NOT NULL,
    tier character varying(20),
    tier_source character varying(20) DEFAULT 'auto'::character varying,
    bd_lifecycle character varying(20),
    lifecycle_source character varying(20) DEFAULT 'auto'::character varying,
    bd_poc_id integer,
    onboarded_date date,
    credit_limit numeric(15,2),
    agreement_name character varying(255),
    agreement_expires_on date,
    notes text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: bd_client_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bd_client_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bd_client_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bd_client_profiles_id_seq OWNED BY public.bd_client_profiles.id;


--
-- Name: bd_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_events (
    id integer NOT NULL,
    client_id integer NOT NULL,
    type character varying(40) NOT NULL,
    title character varying(500) NOT NULL,
    body text,
    ref_type character varying(40),
    ref_id character varying(100),
    actor_id integer,
    actor_name character varying(255),
    source character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: bd_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bd_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bd_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bd_events_id_seq OWNED BY public.bd_events.id;


--
-- Name: bd_grievances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_grievances (
    id integer NOT NULL,
    client_id integer NOT NULL,
    code character varying(30),
    origin character varying(20) DEFAULT 'customer'::character varying NOT NULL,
    related_type character varying(40),
    related_ref character varying(100),
    related_info character varying(500),
    severity character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    category character varying(120),
    description text NOT NULL,
    assignee_id integer,
    assignee_name character varying(255),
    status character varying(30) DEFAULT 'open'::character varying NOT NULL,
    escalated_dept character varying(120),
    escalated_to_id integer,
    escalated_to_name character varying(255),
    escalation_note text,
    internal_reply text,
    root_cause text,
    corrective_action text,
    customer_confirmed boolean DEFAULT false NOT NULL,
    response text,
    source_channel character varying(60),
    sla_target_hours integer,
    responded_at timestamp with time zone,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: bd_grievances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bd_grievances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bd_grievances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bd_grievances_id_seq OWNED BY public.bd_grievances.id;


--
-- Name: bd_meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_meetings (
    id integer NOT NULL,
    client_id integer NOT NULL,
    code character varying(30),
    origin character varying(20) DEFAULT 'ei'::character varying NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    scheduled_for timestamp with time zone,
    old_scheduled_for timestamp with time zone,
    mode character varying(60),
    type character varying(60),
    assignee_id integer,
    assignee_name character varying(255),
    attendees jsonb,
    status character varying(30) DEFAULT 'requested'::character varying NOT NULL,
    agenda text,
    mom text,
    action_items jsonb,
    next_meeting_at timestamp with time zone,
    attended_at timestamp with time zone,
    closed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancel_reason character varying(500),
    related_type character varying(40),
    related_ref character varying(100),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: bd_meetings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bd_meetings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bd_meetings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bd_meetings_id_seq OWNED BY public.bd_meetings.id;


--
-- Name: bd_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_queries (
    id integer NOT NULL,
    client_id integer NOT NULL,
    code character varying(30),
    origin character varying(20) DEFAULT 'customer'::character varying NOT NULL,
    related_type character varying(40),
    related_ref character varying(100),
    related_info character varying(500),
    subject character varying(500),
    description text NOT NULL,
    assignee_id integer,
    assignee_name character varying(255),
    status character varying(30) DEFAULT 'open'::character varying NOT NULL,
    escalated_dept character varying(120),
    escalated_to_id integer,
    escalated_to_name character varying(255),
    escalation_note text,
    internal_reply text,
    response text,
    source_channel character varying(60),
    sla_target_hours integer,
    responded_at timestamp with time zone,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: bd_queries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bd_queries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bd_queries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bd_queries_id_seq OWNED BY public.bd_queries.id;


--
-- Name: boms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boms (
    id integer NOT NULL,
    bom_code character varying(100) NOT NULL,
    bom_sku character varying(100),
    zoho_id character varying(100),
    bom_category character varying(100),
    bom_unit character varying(20),
    bom_hsn character varying(50),
    bom_tax_preference character varying(50),
    bom_returnable boolean,
    bom_associate_items text,
    bom_composite_item boolean DEFAULT true,
    type character varying(50),
    status character varying(50),
    version character varying(50),
    client character varying(200),
    name character varying(300),
    dosage character varying(100),
    pack_size character varying(50),
    site character varying(100),
    category character varying(100),
    claims text,
    project character varying(200),
    market character varying(200),
    created_by character varying(100),
    reviewed_by character varying(100),
    "desc" text,
    spec_bulk text,
    spec_process text,
    spec_fg text,
    spec_pack text,
    spec_tests text,
    spec_release text,
    batch character varying(100),
    yield_pct character varying(20),
    overage character varying(20),
    line character varying(100),
    notes text,
    regulatory text,
    ph_range character varying(50),
    description text,
    rm_lines json,
    sku_rm_lines json,
    sku_bom_limit_qty numeric(18,6),
    sku_bom_limit_uom character varying(20),
    pm_lines json,
    process_steps json,
    stability_summary text,
    product_id integer,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying,
    pr_facility_licences json
);


--
-- Name: boms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.boms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: boms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.boms_id_seq OWNED BY public.boms.id;


--
-- Name: client_appointments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_appointments (
    id integer NOT NULL,
    client_id integer NOT NULL,
    title character varying(500) NOT NULL,
    appointment_date date,
    appointment_time character varying(20),
    type character varying(100),
    with_person character varying(500),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: client_appointments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_appointments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_appointments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_appointments_id_seq OWNED BY public.client_appointments.id;


--
-- Name: client_developments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_developments (
    id integer NOT NULL,
    client_id integer NOT NULL,
    pr_code character varying(100),
    name character varying(500) NOT NULL,
    stage character varying(100),
    status character varying(50) DEFAULT 'new'::character varying,
    due_date date,
    phase character varying(100),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: client_developments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_developments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_developments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_developments_id_seq OWNED BY public.client_developments.id;


--
-- Name: client_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_orders (
    id integer NOT NULL,
    client_id integer NOT NULL,
    product_name character varying(500) NOT NULL,
    quantity character varying(100),
    status character varying(50) DEFAULT 'pending'::character varying,
    due_date date,
    batch_code character varying(100),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: client_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_orders_id_seq OWNED BY public.client_orders.id;


--
-- Name: client_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_queries (
    id integer NOT NULL,
    client_id integer NOT NULL,
    title character varying(500) NOT NULL,
    status character varying(50) DEFAULT 'new'::character varying,
    due_date date,
    category character varying(100),
    notes text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: client_queries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_queries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_queries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_queries_id_seq OWNED BY public.client_queries.id;


--
-- Name: composite_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.composite_items (
    id integer NOT NULL,
    composite_item_id character varying(100),
    composite_item_name character varying(500),
    sales_description text
);


--
-- Name: composite_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.composite_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: composite_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.composite_items_id_seq OWNED BY public.composite_items.id;


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    contact_id character varying(100) NOT NULL,
    created_time character varying(500),
    notes text
);


--
-- Name: customization_packaging_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customization_packaging_options (
    id integer NOT NULL,
    option_id character varying(80) NOT NULL,
    title character varying(200) DEFAULT ''::character varying NOT NULL,
    subtitle character varying(400),
    review_label character varying(400),
    sku_code character varying(100),
    is_custom boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    specs json DEFAULT '{}'::json NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: customization_packaging_options_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customization_packaging_options_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customization_packaging_options_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customization_packaging_options_id_seq OWNED BY public.customization_packaging_options.id;


--
-- Name: customizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customizations (
    custom_id integer NOT NULL,
    name character varying(255),
    concentration character varying(100),
    description text,
    active_composition text,
    indications text,
    how_to_use text,
    specifications text,
    cautions text,
    frequently_asked_questions text,
    category character varying(100),
    incredients text,
    care text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: customizations_custom_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customizations_custom_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customizations_custom_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customizations_custom_id_seq OWNED BY public.customizations.custom_id;


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(30) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: departments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: departments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.departments_id_seq OWNED BY public.departments.id;


--
-- Name: doctor_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_profiles (
    user_id integer NOT NULL,
    doctor_id character varying(255),
    clinic_name character varying(255),
    clinic_address text,
    city character varying(255),
    state character varying(255),
    country character varying(255),
    pincode character varying(255),
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: enquiries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enquiries (
    enquiry_id integer NOT NULL,
    ticket_number character varying(32),
    user_id integer,
    customer json,
    subject character varying(500),
    description text,
    category character varying(80),
    priority character varying(40) DEFAULT 'medium'::character varying,
    status character varying(40) DEFAULT 'new'::character varying,
    source character varying(40),
    ticket_scope character varying(20) DEFAULT 'customer'::character varying,
    collaboration json,
    tags json,
    current_assignee json,
    assignment_history json,
    linked_orders json,
    messages json,
    activities json,
    first_response_at timestamp with time zone,
    sla_deadline timestamp with time zone,
    resolved_at timestamp with time zone,
    resolution_notes text,
    response_count integer DEFAULT 0,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    enquiry_type character varying(255),
    details json,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: COLUMN enquiries.customer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enquiries.customer IS '{ id?, name, email, phone?, company?, isRegistered }';


--
-- Name: COLUMN enquiries.current_assignee; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enquiries.current_assignee IS '{ staffId, staffName, staffEmail, department, assignedAt, assignedBy, isActive }';


--
-- Name: COLUMN enquiries.linked_orders; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enquiries.linked_orders IS '[{ orderId, orderNumber, orderDate, orderStatus, orderTotal, productName, linkedAt, linkedBy, relevance }]';


--
-- Name: COLUMN enquiries.messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enquiries.messages IS '[{ id, ticketId, senderId, senderName, senderType, content, sentAt, isInternal }]';


--
-- Name: COLUMN enquiries.activities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enquiries.activities IS '[{ id, ticketId, type, description, performedBy, timestamp, previousValue?, newValue? }]';


--
-- Name: enquiries_enquiry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.enquiries_enquiry_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enquiries_enquiry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.enquiries_enquiry_id_seq OWNED BY public.enquiries.enquiry_id;


--
-- Name: facility_areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facility_areas (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(200) NOT NULL,
    area_type character varying(30) DEFAULT 'warehouse'::character varying NOT NULL,
    icon character varying(20),
    description character varying(500),
    zoho_location_id character varying(32),
    zoho_meta jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: facility_areas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.facility_areas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: facility_areas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.facility_areas_id_seq OWNED BY public.facility_areas.id;


--
-- Name: fulfillment_batch_splits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_batch_splits (
    id integer NOT NULL,
    fulfillment_order_item_id integer NOT NULL,
    fulfillment_order_id integer NOT NULL,
    production_batch_id integer,
    bmr_no character varying(50),
    bpr_no character varying(50),
    planned_qty integer DEFAULT 0 NOT NULL,
    fg_qty integer DEFAULT 0,
    fg_location character varying(50),
    ff_status character varying(30) DEFAULT 'fg_pending'::character varying NOT NULL,
    picked_qty integer DEFAULT 0,
    picker_name character varying(200),
    pick_date date,
    pick_slip_no character varying(50),
    remarks text,
    invoice_no character varying(100),
    awb_no character varying(100),
    courier character varying(200),
    dispatch_date date,
    eta_date date,
    delivery_date date,
    received_by character varying(200),
    delivery_remarks text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: fulfillment_batch_splits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_batch_splits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fulfillment_batch_splits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fulfillment_batch_splits_id_seq OWNED BY public.fulfillment_batch_splits.id;


--
-- Name: fulfillment_batch_stage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_batch_stage_logs (
    id integer NOT NULL,
    fulfillment_batch_split_id integer NOT NULL,
    fulfillment_order_id integer NOT NULL,
    stage character varying(30) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    actor_name character varying(200),
    actor_user_id integer,
    committed_days numeric(5,1),
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: fulfillment_batch_stage_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_batch_stage_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fulfillment_batch_stage_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fulfillment_batch_stage_logs_id_seq OWNED BY public.fulfillment_batch_stage_logs.id;


--
-- Name: fulfillment_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_comments (
    id integer NOT NULL,
    entity_type character varying(10) NOT NULL,
    entity_id integer NOT NULL,
    by_user_id integer,
    by_user_name character varying(200),
    text text NOT NULL,
    tagged_users json DEFAULT '[]'::json,
    attachments json DEFAULT '[]'::json,
    resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: fulfillment_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fulfillment_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fulfillment_comments_id_seq OWNED BY public.fulfillment_comments.id;


--
-- Name: fulfillment_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_invoices (
    id integer NOT NULL,
    invoice_no character varying(100) NOT NULL,
    fulfillment_order_id integer NOT NULL,
    invoice_date date,
    due_date date,
    prepared_by character varying(200),
    transporter_id integer,
    transporter_name character varying(200),
    lr_awb_no character varying(100),
    remarks text,
    subtotal numeric(14,2) DEFAULT 0,
    gst_percent numeric(5,2) DEFAULT 18,
    total_value numeric(14,2) DEFAULT 0,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    line_items json,
    zoho_invoice_id character varying(64),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: fulfillment_invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fulfillment_invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fulfillment_invoices_id_seq OWNED BY public.fulfillment_invoices.id;


--
-- Name: fulfillment_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_order_items (
    id integer NOT NULL,
    fulfillment_order_id integer NOT NULL,
    item_no character varying(20),
    sku character varying(50),
    product_code character varying(50),
    product_name character varying(300) NOT NULL,
    pack character varying(100),
    ordered_qty integer DEFAULT 0 NOT NULL,
    rate numeric(12,2) DEFAULT 0,
    unit_price numeric(12,2) DEFAULT 0,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: fulfillment_order_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fulfillment_order_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fulfillment_order_items_id_seq OWNED BY public.fulfillment_order_items.id;


--
-- Name: fulfillment_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_orders (
    id integer NOT NULL,
    so_no character varying(50) NOT NULL,
    sales_order_id integer,
    customer_name character varying(300) NOT NULL,
    customer_city character varying(200),
    order_date date,
    due_date date,
    priority character varying(20) DEFAULT 'normal'::character varying NOT NULL,
    so_status character varying(30) DEFAULT 'planned'::character varying NOT NULL,
    so_value numeric(14,2) DEFAULT 0,
    ship_address text,
    payment_terms character varying(255),
    notes text,
    zoho_invoice_id character varying(64),
    invoice_no character varying(100),
    invoice_date date,
    awb_no character varying(100),
    dispatch_date date,
    courier character varying(200),
    commercial_status character varying(30) DEFAULT 'received'::character varying,
    on_hold_previous_status character varying(30),
    vendor_client_id integer,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: fulfillment_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fulfillment_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fulfillment_orders_id_seq OWNED BY public.fulfillment_orders.id;


--
-- Name: fulfillment_sla_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_sla_templates (
    id integer NOT NULL,
    product_id integer,
    stage character varying(30) NOT NULL,
    committed_days numeric(5,1) NOT NULL,
    notes text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: fulfillment_sla_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fulfillment_sla_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fulfillment_sla_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fulfillment_sla_templates_id_seq OWNED BY public.fulfillment_sla_templates.id;


--
-- Name: goods_received_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goods_received_notes (
    id integer NOT NULL,
    grn_no character varying(100) NOT NULL,
    purchase_order_id integer,
    po_no character varying(100),
    vendor character varying(300),
    type character varying(10),
    items integer DEFAULT 0,
    po_value numeric(14,2),
    expected_date date,
    received_date date,
    assigned_to character varying(200),
    qc_status character varying(50),
    qc_by character varying(200),
    qc_specs json,
    status character varying(50),
    shipment_batch_id integer,
    stage character varying(30),
    shipped_qty numeric(14,4),
    line_items json,
    workflow_steps json,
    invoice_no character varying(100),
    invoice_amount numeric(14,2),
    grn_date date,
    no_of_boxes integer,
    units_per_box integer,
    last_box_units integer,
    location_prefix character varying(50),
    location_zone character varying(200),
    grn_batch_mfg character varying(100),
    expiry date,
    mfg_batch character varying(100),
    generated_labels json,
    receipt_source character varying(30) DEFAULT 'po'::character varying,
    source_documents json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: goods_received_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.goods_received_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: goods_received_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.goods_received_notes_id_seq OWNED BY public.goods_received_notes.id;


--
-- Name: item_dedicated_facility_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_dedicated_facility_locations (
    id integer NOT NULL,
    item_key character varying(80) NOT NULL,
    raw_material_id integer,
    pack_material_id integer,
    product_id integer,
    wh_location_id integer,
    wh_rack_id integer,
    prod_location_id integer,
    prod_rack_id integer,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: item_dedicated_facility_locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_dedicated_facility_locations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_dedicated_facility_locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_dedicated_facility_locations_id_seq OWNED BY public.item_dedicated_facility_locations.id;


--
-- Name: item_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_groups (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    icon character varying(20),
    type character varying(10) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    purpose character varying(255),
    status character varying(20) DEFAULT 'Active'::character varying,
    notes text,
    member_ids json,
    proposed_alternates json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: item_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_groups_id_seq OWNED BY public.item_groups.id;


--
-- Name: item_list_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_list_tiers (
    id integer NOT NULL,
    item_list_vendor_rate_id integer NOT NULL,
    moq_min numeric(14,4) NOT NULL,
    moq_max numeric(14,4),
    price_per_unit numeric(14,2) NOT NULL,
    valid_till date,
    note character varying(500),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: item_list_tiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_list_tiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_list_tiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_list_tiers_id_seq OWNED BY public.item_list_tiers.id;


--
-- Name: item_list_vendor_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_list_vendor_rates (
    id integer NOT NULL,
    items_list_id integer NOT NULL,
    vendor_id integer NOT NULL,
    party_type character varying(20) DEFAULT 'vendor'::character varying NOT NULL,
    default_rate numeric(14,2),
    default_moq numeric(14,4),
    lead_time_days integer,
    currency character varying(10) DEFAULT 'INR'::character varying,
    payment_terms character varying(512),
    status character varying(50) DEFAULT 'active'::character varying,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: item_list_vendor_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_list_vendor_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_list_vendor_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_list_vendor_rates_id_seq OWNED BY public.item_list_vendor_rates.id;


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    item_id character varying(100) NOT NULL,
    created_time character varying(500),
    sales_description text
);


--
-- Name: items_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items_list (
    id integer NOT NULL,
    type character varying(10) NOT NULL,
    raw_material_id integer,
    pack_material_id integer,
    product_id integer,
    status character varying(50) DEFAULT 'Active'::character varying,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: items_list_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.items_list_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: items_list_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.items_list_id_seq OWNED BY public.items_list.id;


--
-- Name: items_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items_master (
    id integer NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(300),
    type character varying(50),
    status character varying(50),
    bom_ids json,
    raw_material_ids json,
    pack_material_ids json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: items_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.items_master_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: items_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.items_master_id_seq OWNED BY public.items_master.id;


--
-- Name: logistics_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logistics_schedules (
    id integer NOT NULL,
    tracking_no character varying(200) NOT NULL,
    transporter character varying(200) NOT NULL,
    dispatch_date date NOT NULL,
    eta_date date NOT NULL,
    vehicle_no character varying(100) NOT NULL,
    status character varying(50) DEFAULT 'Active'::character varying NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: logistics_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.logistics_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: logistics_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.logistics_schedules_id_seq OWNED BY public.logistics_schedules.id;


--
-- Name: master_approval_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.master_approval_status_history (
    id integer NOT NULL,
    master_kind character varying(4) NOT NULL,
    master_id integer NOT NULL,
    master_code character varying(120),
    from_status character varying(64),
    to_status character varying(64) NOT NULL,
    changed_by_user_id integer,
    changed_by_display_name character varying(255),
    source character varying(64),
    note text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: master_approval_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.master_approval_status_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: master_approval_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.master_approval_status_history_id_seq OWNED BY public.master_approval_status_history.id;


--
-- Name: material_request_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_request_notes (
    id integer NOT NULL,
    mrn_no character varying(100) NOT NULL,
    requested_by character varying(200),
    status character varying(50) DEFAULT 'Pending'::character varying,
    assigned_picker character varying(200),
    transfer_team character varying(200),
    line_items json,
    line_transfer_status json,
    notes text,
    bmr_no character varying(50),
    source character varying(20),
    is_inbound_from_mu boolean DEFAULT false,
    received_at_mu timestamp with time zone,
    generated_labels json,
    no_of_boxes integer,
    units_per_box integer,
    location_prefix character varying(100),
    grn_batch_mfg character varying(100),
    expiry date,
    mfg_batch character varying(100),
    wh_dispatch_zone character varying(100),
    mu_receive_zone character varying(100),
    mu_receive_rack character varying(100),
    required_by_date date,
    logistics_tracking_no character varying(200),
    logistics_transporter character varying(200),
    logistics_dispatch_date date,
    logistics_eta_date date,
    logistics_vehicle_no character varying(100),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: material_request_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.material_request_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: material_request_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.material_request_notes_id_seq OWNED BY public.material_request_notes.id;


--
-- Name: module_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.module_definitions (
    id integer NOT NULL,
    name character varying(100) DEFAULT 'default'::character varying NOT NULL,
    definition_json json NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: COLUMN module_definitions.definition_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.module_definitions.definition_json IS 'Full { modules: ModulePermission[], globalSettings: GlobalSettings }';


--
-- Name: module_definitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.module_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: module_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.module_definitions_id_seq OWNED BY public.module_definitions.id;


--
-- Name: newdevelopments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.newdevelopments (
    product_id integer NOT NULL,
    user_id integer NOT NULL,
    status character varying(255),
    customization character varying(255),
    sale character varying(255),
    hsn_code character varying(255),
    product_status character varying(255),
    product_code character varying(255),
    generic_name character varying(255),
    brand_name character varying(255),
    super_category character varying(255),
    product_category character varying(255),
    sub_category character varying(255),
    sub_sub_category character varying(255),
    product_sku character varying(255),
    label_claims text,
    product_description_cust text,
    product_description text,
    product_price numeric(12,2),
    tax_rate numeric(6,2),
    gst_input character varying(255),
    product_cover_image character varying(255),
    product_cover_image_customization character varying(255),
    product_ingrediants text,
    excepients text,
    indications text,
    usage text,
    cautions text,
    application_area character varying(255),
    dosage_form_type character varying(255),
    phrange character varying(255),
    color character varying(255),
    fragrance character varying(255),
    vascosity character varying(255),
    other_specs text,
    technology_used text,
    recomendedproducts text,
    packing_recommendations text,
    batch_no character varying(255),
    sub_cat_char character varying(255),
    grid_sub_cat character varying(255),
    skin_type character varying(255),
    product_specializations text,
    usage_time character varying(255),
    application_specifications text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: newdevelopments_product_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.newdevelopments_product_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: newdevelopments_product_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.newdevelopments_product_id_seq OWNED BY public.newdevelopments.product_id;


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    order_item_id integer NOT NULL,
    order_id integer NOT NULL,
    product_id integer NOT NULL,
    sef_id integer,
    item_type character varying(255),
    quantity integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    discount_amount numeric(10,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(10,2) DEFAULT 0 NOT NULL,
    line_total numeric(10,2) NOT NULL,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: order_items_order_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_items_order_item_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_items_order_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_items_order_item_id_seq OWNED BY public.order_items.order_item_id;


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    order_id integer NOT NULL,
    user_id integer NOT NULL,
    billing_address_id integer NOT NULL,
    shipping_address_id integer NOT NULL,
    order_status public.enum_orders_order_status DEFAULT 'pending'::public.enum_orders_order_status NOT NULL,
    payment_status public.enum_orders_payment_status DEFAULT 'pending'::public.enum_orders_payment_status NOT NULL,
    so_no character varying(255),
    fulfillment_stage public.enum_orders_fulfillment_stage DEFAULT 'pending'::public.enum_orders_fulfillment_stage NOT NULL,
    subtotal numeric(10,2) NOT NULL,
    discount_total numeric(10,2) DEFAULT 0 NOT NULL,
    tax_total numeric(10,2) NOT NULL,
    shipping_total numeric(10,2) NOT NULL,
    grand_total numeric(10,2) NOT NULL,
    advance_amount_due numeric(10,2) DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: orders_order_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.orders_order_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_order_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.orders_order_id_seq OWNED BY public.orders.order_id;


--
-- Name: pack_materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pack_materials (
    id integer NOT NULL,
    code character varying(100) NOT NULL,
    description character varying(500),
    type character varying(100),
    level character varying(50),
    "group" character varying(100),
    material character varying(255),
    size_spec character varying(255),
    price_per_pc numeric(12,2),
    moq integer,
    lead_time_days integer,
    print_status character varying(100),
    approval_assigned_user_id integer,
    approval_assigned_display_name character varying(255),
    approval_stage_assignees json,
    products json,
    zoho_id character varying(100),
    zoho_sku_code character varying(100),
    hsn_code character varying(50),
    unit character varying(20),
    tax_pref character varying(50),
    pkg_returnable boolean,
    pkg_associate_items text,
    sales_purchase_account character varying(255),
    form_data json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: pack_materials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pack_materials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pack_materials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pack_materials_id_seq OWNED BY public.pack_materials.id;


--
-- Name: packaging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packaging (
    id integer NOT NULL,
    package_code character varying(100),
    package_name character varying(255),
    package_sku character varying(100),
    bottom character varying(50),
    cap_type character varying(50),
    bottom_name character varying(100),
    bottom_material character varying(50),
    cap_name character varying(100),
    cap_material character varying(50),
    bottom_color character varying(50),
    cap_color character varying(50),
    bottom_weight character varying(50),
    cap_weight character varying(50),
    dispenser_volume character varying(50),
    minimum_order_quantity character varying(50),
    budget character varying(50),
    comments text,
    status character varying(20) DEFAULT 'active'::character varying,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: packaging_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.packaging_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: packaging_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.packaging_id_seq OWNED BY public.packaging.id;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id integer NOT NULL,
    "paymentId" character varying(255),
    "razorpayOrderId" character varying(255),
    gateway public.enum_payments_gateway NOT NULL,
    "gatewayReference" character varying(255),
    "paidAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "remainingAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    currency character varying(255) DEFAULT 'INR'::character varying NOT NULL,
    status public.enum_payments_status DEFAULT 'pending'::public.enum_payments_status NOT NULL,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "orderOrderId" integer,
    "UserUserid" integer
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    permission_id integer NOT NULL,
    resource character varying(100) NOT NULL,
    action public.enum_permissions_action NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: permissions_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.permissions_permission_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permissions_permission_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.permissions_permission_id_seq OWNED BY public.permissions.permission_id;


--
-- Name: planning_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_batches (
    id integer NOT NULL,
    planning_extracted_id integer NOT NULL,
    sequence integer DEFAULT 1 NOT NULL,
    batch_code character varying(64) NOT NULL,
    size_kg numeric(14,2),
    rm_lines json,
    pm_lines json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: planning_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.planning_batches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planning_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.planning_batches_id_seq OWNED BY public.planning_batches.id;


--
-- Name: planning_bom_override; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_bom_override (
    id integer NOT NULL,
    planning_extracted_id integer NOT NULL,
    rm_lines json,
    pm_lines json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: planning_bom_override_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.planning_bom_override_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planning_bom_override_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.planning_bom_override_id_seq OWNED BY public.planning_bom_override.id;


--
-- Name: planning_extracted; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_extracted (
    id integer NOT NULL,
    sales_order_id integer NOT NULL,
    product_id integer NOT NULL,
    order_qty_display character varying(100),
    total_kg_display character varying(100),
    order_date date,
    due_date date,
    batch_size_display character varying(100),
    batches_required integer,
    bom_status character varying(80),
    approved_by character varying(200),
    raw_materials json,
    packaging_materials json,
    color character varying(50),
    batch_count integer,
    batch_size_kg numeric(12,2),
    planned_start_date date,
    production_line character varying(200),
    bom_confirmed_at timestamp with time zone,
    bom_specific_gravity numeric(5,3),
    custom_batches json,
    sent_batch_indices json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: planning_extracted_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.planning_extracted_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planning_extracted_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.planning_extracted_id_seq OWNED BY public.planning_extracted.id;


--
-- Name: planning_quotation_asks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_quotation_asks (
    id integer NOT NULL,
    planning_extracted_id integer NOT NULL,
    item_type character varying(10) NOT NULL,
    raw_material_id integer,
    pack_material_id integer,
    item_code character varying(120),
    item_name character varying(300),
    quantity_requested numeric(18,6) NOT NULL,
    unit character varying(20),
    vendor_hint character varying(300),
    moq_hint numeric(18,6),
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    notes text,
    requested_by character varying(200),
    fulfilled_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: planning_quotation_asks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.planning_quotation_asks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: planning_quotation_asks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.planning_quotation_asks_id_seq OWNED BY public.planning_quotation_asks.id;


--
-- Name: po_tracking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.po_tracking (
    id integer NOT NULL,
    purchase_order_id integer NOT NULL,
    po_released_at date,
    po_released_note character varying(500),
    advance_paid_at date,
    advance_paid_note character varying(500),
    payment_transaction_no character varying(100),
    payment_mode character varying(50),
    payment_transaction_date date,
    vendor_confirmed_at date,
    vendor_confirmed_note character varying(500),
    shipped_at date,
    shipped_note character varying(500),
    order_tracking_ref character varying(200),
    delivered_at date,
    delivered_note character varying(500),
    under_grn_at date,
    under_grn_note character varying(500),
    grn_complete_at date,
    grn_complete_note character varying(500),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: po_tracking_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.po_tracking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: po_tracking_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.po_tracking_id_seq OWNED BY public.po_tracking.id;


--
-- Name: procurement_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procurement_quotations (
    id integer NOT NULL,
    procurement_request_id integer,
    vendor_id integer NOT NULL,
    quote_date date,
    quoted_by character varying(200),
    attachment_ref character varying(500),
    attachment_status character varying(50) DEFAULT 'pending'::character varying,
    items json,
    lead_time_days integer,
    payment_terms text,
    valid_till date,
    total_value numeric(18,2),
    notes text,
    status character varying(50) DEFAULT 'pending'::character varying,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: COLUMN procurement_quotations.items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.procurement_quotations.items IS 'Array of { itemId, name, raw_material_id?, pack_material_id?, orderQty, pricePerUnit, uom, totalValue }';


--
-- Name: procurement_quotations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.procurement_quotations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: procurement_quotations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.procurement_quotations_id_seq OWNED BY public.procurement_quotations.id;


--
-- Name: procurement_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procurement_requests (
    id integer NOT NULL,
    planning_extracted_id integer NOT NULL,
    planning_batch_id integer,
    priority character varying(50),
    required_by_date date,
    notes text,
    items json,
    status character varying(50) DEFAULT 'Pending'::character varying,
    preferred_vendor character varying(300),
    requested_by character varying(200),
    stock_check_assigned_to character varying(200),
    stock_check_status character varying(50),
    stock_check_due_date date,
    stock_check_notes text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: COLUMN procurement_requests.items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.procurement_requests.items IS 'Array of { type, raw_material_id?, pack_material_id?, product_id?, quantity_requested, unit, line_notes?, moq_min?, planned_unit_price?, lead_time_days?, required?, sih?, shortage?, code?, name? }';


--
-- Name: procurement_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.procurement_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: procurement_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.procurement_requests_id_seq OWNED BY public.procurement_requests.id;


--
-- Name: product_customizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_customizations (
    customization_id integer NOT NULL,
    user_id integer NOT NULL,
    product_id integer,
    category character varying(255),
    formulation json,
    "formulationSummary" text,
    care character varying(255),
    "packagingType" character varying(255) DEFAULT 'standard'::character varying,
    packaging_image character varying(255),
    "userNotes" text,
    packaging text,
    status character varying(255) DEFAULT 'Pending'::character varying,
    assigned_bd_user_id integer,
    assigned_bd_name character varying(255),
    assigned_bd_email character varying(255),
    assigned_at timestamp with time zone,
    internal_notes text,
    life_cycle_status character varying(255) DEFAULT 'active'::character varying,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: product_customizations_customization_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_customizations_customization_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_customizations_customization_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_customizations_customization_id_seq OWNED BY public.product_customizations.customization_id;


--
-- Name: production_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_batches (
    id integer NOT NULL,
    bmr_no character varying(50) NOT NULL,
    bpr_no character varying(50) NOT NULL,
    product_name character varying(300) NOT NULL,
    sku character varying(50) NOT NULL,
    so_no character varying(50),
    order_qty integer,
    batch_size integer,
    batch_no character varying(20),
    batch_index integer,
    total_batches integer,
    planning_batch_id integer,
    bmr_status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    bpr_status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    color character varying(30),
    process_type character varying(10),
    homogenizer boolean DEFAULT false,
    main_vessel character varying(20),
    supporting_tanks json,
    filling_line character varying(20),
    filling_type character varying(20),
    packaging_line character varying(20),
    monocarton boolean DEFAULT false,
    shrink boolean DEFAULT false,
    team_bmr json,
    team_bpr json,
    qc_officer_bmr character varying(20),
    qc_officer_bpr character varying(20),
    scheduled_mu_zone character varying(80),
    schedule_remarks text,
    mfg_date date,
    fill_date date,
    pack_date date,
    fg_date date,
    rm_connect_date date,
    pm_connect_date date,
    rm_reserved boolean DEFAULT false,
    pm_reserved boolean DEFAULT false,
    rm_connected boolean DEFAULT false,
    pm_connected boolean DEFAULT false,
    dispensing_rm json,
    dispensing_pm json,
    mu_dispensing_bundle_id character varying(80),
    mu_dispensing_bundles json,
    bulk_yield numeric(12,3),
    fill_yield numeric(12,3),
    fg_yield numeric(12,3),
    bulk_batch_accepted boolean,
    fill_batch_accepted boolean,
    fg_batch_accepted boolean,
    qc_specs json,
    remarks text,
    due_date date,
    compatible_vessels json,
    compatible_fill_lines json,
    compatible_pack_lines json,
    required_volume_liters numeric(10,2),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: production_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.production_batches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: production_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.production_batches_id_seq OWNED BY public.production_batches.id;


--
-- Name: production_equipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_equipment (
    id integer NOT NULL,
    equipment_id character varying(20) NOT NULL,
    name character varying(200) NOT NULL,
    category public.enum_production_equipment_category NOT NULL,
    capacity integer,
    speed integer,
    type character varying(50) NOT NULL,
    homogenizer boolean DEFAULT false,
    process_types json,
    compatible json,
    supports json,
    status character varying(30) DEFAULT 'idle'::character varying NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: production_equipment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.production_equipment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: production_equipment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.production_equipment_id_seq OWNED BY public.production_equipment.id;


--
-- Name: production_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_team_members (
    id integer NOT NULL,
    member_id character varying(20) NOT NULL,
    user_id integer,
    name character varying(200) NOT NULL,
    role character varying(100) NOT NULL,
    department public.enum_production_team_members_department NOT NULL,
    available boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: production_team_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.production_team_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: production_team_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.production_team_members_id_seq OWNED BY public.production_team_members.id;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    product_id integer NOT NULL,
    status character varying(255),
    availability character varying(255),
    deleted_at timestamp with time zone,
    product_code character varying(255),
    zoho_sku_code character varying(255),
    generic_name character varying(255),
    brand_name character varying(255),
    tax_rate numeric(5,2),
    product_description text,
    incredients text,
    how_to_use text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    mrp_price numeric(10,2),
    buy_price numeric(10,2),
    product_name character varying(255),
    commercial_name character varying(255),
    category character varying(255),
    lifecycle_status character varying(255),
    form character varying(100),
    fill_size character varying(50),
    batch_size_kg integer,
    lead_time_days integer,
    shelf_life_months integer,
    version character varying(50),
    license_cml character varying(100),
    theoretical_yield_pct numeric(5,2),
    pao_months integer,
    manufacturing_location character varying(255),
    equipment_vessel character varying(255),
    storage_conditions text,
    approved_claims text,
    ph_range character varying(50),
    viscosity_range character varying(100),
    spf_pa_rating character varying(50),
    appearance character varying(255),
    odour character varying(255),
    fill_weight_spec character varying(100),
    stability_summary text,
    pr_record_type character varying(20),
    zoho_item_id character varying(64),
    approval_assigned_user_id integer,
    approval_assigned_display_name character varying(255),
    approval_stage_assignees json,
    approval_team_pending json,
    form_data json
);


--
-- Name: products_product_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.products_product_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products_product_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.products_product_id_seq OWNED BY public.products.product_id;


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id integer NOT NULL,
    order_id character varying(100) NOT NULL,
    vendor_name character varying(300),
    branch character varying(100),
    order_date date,
    expected_shipment_date date,
    reference character varying(200),
    payment_terms character varying(100),
    status character varying(50),
    order_status json,
    form_data json,
    items json,
    zoho_purchase_order_id character varying(100),
    zoho_bill_id character varying(100),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: purchase_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_orders_id_seq OWNED BY public.purchase_orders.id;


--
-- Name: quote_actuals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_actuals (
    id integer NOT NULL,
    bom_code character varying(100) NOT NULL,
    job_ref text,
    pre_quote_id integer,
    post_quote_id integer,
    batch_size integer,
    yield_pct numeric(5,2),
    actual_rm numeric(10,4),
    actual_pm numeric(10,4),
    actual_conversion numeric(10,4),
    actual_overhead numeric(10,4),
    actual_total numeric(10,4),
    est_rm numeric(10,4),
    est_pm numeric(10,4),
    est_conversion numeric(10,4),
    est_overhead numeric(10,4),
    est_total numeric(10,4),
    notes text,
    entered_by integer,
    entered_by_name character varying(255),
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: quote_actuals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_actuals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_actuals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_actuals_id_seq OWNED BY public.quote_actuals.id;


--
-- Name: quote_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_audit_log (
    id integer NOT NULL,
    entity_type character varying(40) NOT NULL,
    entity_id integer,
    action character varying(20) NOT NULL,
    summary text,
    changed_by integer,
    changed_by_name character varying(255),
    created_at timestamp with time zone
);


--
-- Name: quote_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_audit_log_id_seq OWNED BY public.quote_audit_log.id;


--
-- Name: quote_category_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_category_rates (
    id integer NOT NULL,
    category character varying(100) NOT NULL,
    wastage_pct numeric(5,2) DEFAULT 3,
    notes text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: quote_category_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_category_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_category_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_category_rates_id_seq OWNED BY public.quote_category_rates.id;


--
-- Name: quote_conversion_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_conversion_rates (
    id integer NOT NULL,
    packaging_type character varying(50) NOT NULL,
    moq_band character varying(20) NOT NULL,
    volume_key character varying(10) NOT NULL,
    rate numeric(8,2) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: quote_conversion_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_conversion_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_conversion_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_conversion_rates_id_seq OWNED BY public.quote_conversion_rates.id;


--
-- Name: quote_dispatch_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_dispatch_config (
    id integer NOT NULL,
    grade_ref character varying(50) DEFAULT 'default'::character varying NOT NULL,
    dispatch_days integer NOT NULL,
    notes text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: quote_dispatch_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_dispatch_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_dispatch_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_dispatch_config_id_seq OWNED BY public.quote_dispatch_config.id;


--
-- Name: quote_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_emails (
    id integer NOT NULL,
    quote_ref text,
    to_email text NOT NULL,
    cc_email text,
    subject text,
    status character varying(12) DEFAULT 'sent'::character varying NOT NULL,
    error text,
    message_id text,
    created_at timestamp with time zone
);


--
-- Name: quote_emails_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_emails_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_emails_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_emails_id_seq OWNED BY public.quote_emails.id;


--
-- Name: quote_grades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_grades (
    id integer NOT NULL,
    name character varying(150) NOT NULL,
    description text,
    moq_labels json NOT NULL,
    moq_values json NOT NULL,
    markups json NOT NULL,
    zero_pm boolean DEFAULT false NOT NULL,
    bmap json NOT NULL,
    qc_days integer,
    is_system boolean DEFAULT false NOT NULL,
    grade_ref character varying(50),
    created_by integer,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: quote_grades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_grades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_grades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_grades_id_seq OWNED BY public.quote_grades.id;


--
-- Name: quote_manufacturing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_manufacturing_rules (
    id integer NOT NULL,
    product_type character varying(50) NOT NULL,
    product_subtype character varying(100) DEFAULT ''::character varying NOT NULL,
    band_index integer NOT NULL,
    manufacturing_days integer NOT NULL,
    cycle_time_days integer,
    notes text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: quote_manufacturing_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_manufacturing_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_manufacturing_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_manufacturing_rules_id_seq OWNED BY public.quote_manufacturing_rules.id;


--
-- Name: quote_overheads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_overheads (
    id integer NOT NULL,
    product_category character varying(50) DEFAULT 'all'::character varying NOT NULL,
    head_name character varying(100) NOT NULL,
    band_values json NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: quote_overheads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_overheads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_overheads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_overheads_id_seq OWNED BY public.quote_overheads.id;


--
-- Name: quote_procurement_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_procurement_rules (
    id integer NOT NULL,
    material_type character varying(5) NOT NULL,
    category_or_material character varying(100) NOT NULL,
    individual_lead_days integer NOT NULL,
    batch_lead_days integer,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: quote_procurement_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_procurement_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_procurement_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_procurement_rules_id_seq OWNED BY public.quote_procurement_rules.id;


--
-- Name: quote_qc_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_qc_rules (
    id integer NOT NULL,
    grade_ref character varying(50) NOT NULL,
    qc_days integer NOT NULL,
    notes text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: quote_qc_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quote_qc_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quote_qc_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quote_qc_rules_id_seq OWNED BY public.quote_qc_rules.id;


--
-- Name: raw_materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.raw_materials (
    id integer NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(255),
    inci character varying(255),
    category character varying(100),
    rm_type character varying(50),
    uom character varying(20),
    price_per_kg numeric(12,2),
    gst numeric(5,2),
    shelf character varying(20),
    specific_gravity numeric(5,3),
    lead_time_days integer,
    status character varying(50),
    approval_assigned_user_id integer,
    approval_assigned_display_name character varying(255),
    approval_stage_assignees json,
    products json,
    "group" character varying(100),
    zoho_id character varying(100),
    zoho_sku_code character varying(100),
    hsn_code character varying(50),
    tax_pref character varying(50),
    sales_purchase_account character varying(255),
    form_data json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying,
    master_lifecycle_status character varying(50),
    rm_owner character varying(255),
    universal_swap_eligibility character varying(10),
    functional_equivalents text
);


--
-- Name: raw_materials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.raw_materials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: raw_materials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.raw_materials_id_seq OWNED BY public.raw_materials.id;


--
-- Name: refreshTokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."refreshTokens" (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    "refreshToken" character varying(255) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: refreshTokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."refreshTokens_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refreshTokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."refreshTokens_id_seq" OWNED BY public."refreshTokens".id;


--
-- Name: reserved_batch_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reserved_batch_items (
    id integer NOT NULL,
    production_batch_id integer,
    fulfillment_order_item_id integer,
    planning_extracted_id integer,
    raw_material_id integer,
    pack_material_id integer,
    quantity_reserved numeric(28,16) DEFAULT 0 NOT NULL,
    unit character varying(20) DEFAULT 'KG'::character varying,
    so_no character varying(50),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: reserved_batch_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reserved_batch_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reserved_batch_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reserved_batch_items_id_seq OWNED BY public.reserved_batch_items.id;


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_id integer NOT NULL,
    permission_id integer NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    role_id integer NOT NULL,
    role_code character varying(50) NOT NULL,
    role_name character varying(100) NOT NULL,
    description text,
    level character varying(50) DEFAULT 'staff'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    permissions_json json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: COLUMN roles.permissions_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.roles.permissions_json IS 'Dashboard module/submodule permissions (option A)';


--
-- Name: roles_role_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_role_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_role_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_role_id_seq OWNED BY public.roles.role_id;


--
-- Name: sales_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_orders (
    id integer NOT NULL,
    order_id character varying(100) NOT NULL,
    customer_name character varying(300),
    branch character varying(100),
    order_date date,
    expected_shipment_date date,
    reference character varying(200),
    payment_terms character varying(100),
    status character varying(50),
    order_status json,
    form_data json,
    items json,
    created_by character varying(200),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: sales_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_orders_id_seq OWNED BY public.sales_orders.id;


--
-- Name: saved_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_quotes (
    id integer NOT NULL,
    quote_ref character varying(40) NOT NULL,
    quote_name text,
    customer_name text,
    bom_id integer,
    bom_code text,
    grade integer,
    mode character varying(10),
    payload json,
    result json,
    headline_sell numeric(12,2),
    headline_moq text,
    status character varying(30) DEFAULT 'draft'::character varying,
    status_history json DEFAULT '[]'::json,
    notes text,
    gst_pct numeric(5,2) DEFAULT 18,
    valid_until date,
    client_id integer,
    prepared_by text,
    sales_order_id integer,
    sales_order_ref character varying(100),
    version integer DEFAULT 1,
    root_quote_id integer,
    superseded_by integer,
    quote_type character varying(20) DEFAULT 'full'::character varying,
    quote_category character varying(30) DEFAULT 'pre_production'::character varying,
    job_ref text,
    pre_quote_id integer,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: saved_quotes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.saved_quotes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: saved_quotes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.saved_quotes_id_seq OWNED BY public.saved_quotes.id;


--
-- Name: shipment_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_batches (
    id integer NOT NULL,
    code character varying(40),
    purchase_order_id integer,
    po_no character varying(100),
    vendor character varying(300),
    vehicle_no character varying(60),
    driver_name character varying(200),
    driver_phone character varying(40),
    transporter character varying(200),
    shipped_date date,
    vendor_invoice_no character varying(100),
    expected_arrival date,
    total_qty numeric(14,4),
    line_count integer DEFAULT 0,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: shipment_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shipment_batches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shipment_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shipment_batches_id_seq OWNED BY public.shipment_batches.id;


--
-- Name: staff_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_profiles (
    user_id integer NOT NULL,
    role_id integer NOT NULL,
    department public.enum_staff_profiles_department,
    dep_level character varying(255),
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: transporters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transporters (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    code character varying(50),
    contact_phone character varying(50),
    contact_email character varying(255),
    tracking_url character varying(500),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: transporters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transporters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transporters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transporters_id_seq OWNED BY public.transporters.id;


--
-- Name: universal_swap_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.universal_swap_history (
    id integer NOT NULL,
    from_raw_material_id integer NOT NULL,
    to_raw_material_id integer NOT NULL,
    swap_ratio numeric(10,4) DEFAULT 1,
    reason text,
    approved_by character varying(255),
    approved_by_user_id integer,
    affected_group_ids json,
    affected_bom_ids json,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: universal_swap_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.universal_swap_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: universal_swap_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.universal_swap_history_id_seq OWNED BY public.universal_swap_history.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    userid integer NOT NULL,
    fname character varying(255),
    lname character varying(255),
    display_name character varying(255),
    email character varying(255) NOT NULL,
    mobile character varying(255),
    password character varying(255) NOT NULL,
    usertype character varying(255),
    portal_signup_role character varying(64),
    department character varying(255),
    status character varying(255),
    doctor_id_legacy character varying(255),
    verify_status character varying(255),
    advance_payment boolean DEFAULT false,
    advance_amount numeric(10,2),
    zoho_contact_id character varying(64),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    last_login_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: users_userid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_userid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_userid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_userid_seq OWNED BY public.users.userid;


--
-- Name: vendor_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_clients (
    id integer NOT NULL,
    entity_code character varying(64) NOT NULL,
    type character varying(20) NOT NULL,
    zoho_id character varying(100),
    name character varying(300),
    email character varying(255),
    phone character varying(64),
    location character varying(200),
    country character varying(100),
    city character varying(100),
    category character varying(100),
    status character varying(50),
    payment_terms character varying(100),
    notes text,
    rating integer,
    moq character varying(100),
    lead_time character varying(100),
    data jsonb,
    priority character varying(20),
    segment character varying(200),
    since_year integer,
    revenue_value numeric(15,2),
    avatar_color character varying(50),
    account_manager_id integer,
    user_id integer,
    contacts jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: vendor_clients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_clients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_clients_id_seq OWNED BY public.vendor_clients.id;


--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    contact_id character varying(100) NOT NULL,
    created_time character varying(500),
    notes text,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255)
);


--
-- Name: warehouse_inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_inventory (
    id integer NOT NULL,
    item_type character varying(10) NOT NULL,
    raw_material_id integer,
    pack_material_id integer,
    product_id integer,
    zone text,
    rack text,
    wh_stock numeric(28,16) DEFAULT 0,
    wh_unit character varying(20) DEFAULT 'KG'::character varying,
    ml1_stock numeric(28,16) DEFAULT 0,
    ml2_stock numeric(28,16) DEFAULT 0,
    stock_in_hand numeric(28,16) DEFAULT 0,
    reserved numeric(28,16) DEFAULT 0,
    in_transit numeric(28,16) DEFAULT 0,
    reorder_pt numeric(14,2) DEFAULT 0,
    avg_mo numeric(14,2) DEFAULT 0,
    qc_status character varying(50) DEFAULT 'In Stock'::character varying,
    batch_number character varying(50),
    expiry_date date,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: warehouse_inventory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_inventory_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_inventory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_inventory_id_seq OWNED BY public.warehouse_inventory.id;


--
-- Name: warehouse_inventory_location_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_inventory_location_history (
    id integer NOT NULL,
    warehouse_inventory_id integer NOT NULL,
    item_type character varying(10) NOT NULL,
    raw_material_id integer,
    pack_material_id integer,
    product_id integer,
    from_zone character varying(100),
    from_rack character varying(100),
    to_zone character varying(100),
    to_rack character varying(100),
    qty_delta numeric(28,16),
    action_type character varying(30),
    source_grn_id integer,
    source_mrn_id integer,
    moved_at timestamp with time zone NOT NULL,
    reserved_delta numeric(28,16),
    reserved_after numeric(28,16),
    production_batch_id integer,
    batch_no character varying(50),
    dispensing_bundle_id character varying(80),
    changes_json json,
    note text,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: warehouse_inventory_location_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_inventory_location_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_inventory_location_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_inventory_location_history_id_seq OWNED BY public.warehouse_inventory_location_history.id;


--
-- Name: warehouse_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_locations (
    id integer NOT NULL,
    area_id integer,
    code character varying(50) NOT NULL,
    name character varying(200) NOT NULL,
    location_type character varying(30) DEFAULT 'warehouse'::character varying NOT NULL,
    zone_label character varying(50),
    icon character varying(20),
    area_sqm integer,
    description character varying(500),
    utilisation_pct numeric(5,2),
    zoho_warehouse_id character varying(32),
    zoho_location_id character varying(32),
    is_active boolean DEFAULT true NOT NULL,
    is_zoho_primary boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    zoho_meta jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: warehouse_locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_locations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_locations_id_seq OWNED BY public.warehouse_locations.id;


--
-- Name: warehouse_rack_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_rack_items (
    id integer NOT NULL,
    rack_id integer NOT NULL,
    warehouse_inventory_id integer NOT NULL,
    qty_wh numeric(28,16) DEFAULT 0,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: warehouse_rack_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_rack_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_rack_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_rack_items_id_seq OWNED BY public.warehouse_rack_items.id;


--
-- Name: warehouse_racks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_racks (
    id integer NOT NULL,
    location_id integer NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100),
    description character varying(300),
    levels integer DEFAULT 4,
    slots_total integer DEFAULT 16,
    utilisation_pct numeric(5,2),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    lifecycle_status character varying(255) DEFAULT 'active'::character varying
);


--
-- Name: warehouse_racks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_racks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_racks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_racks_id_seq OWNED BY public.warehouse_racks.id;


--
-- Name: addresses address_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses ALTER COLUMN address_id SET DEFAULT nextval('public.addresses_address_id_seq'::regclass);


--
-- Name: appointments appointmentid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments ALTER COLUMN appointmentid SET DEFAULT nextval('public.appointments_appointmentid_seq'::regclass);


--
-- Name: authentication id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authentication ALTER COLUMN id SET DEFAULT nextval('public.authentication_id_seq'::regclass);


--
-- Name: bd_client_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_client_profiles ALTER COLUMN id SET DEFAULT nextval('public.bd_client_profiles_id_seq'::regclass);


--
-- Name: bd_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_events ALTER COLUMN id SET DEFAULT nextval('public.bd_events_id_seq'::regclass);


--
-- Name: bd_grievances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_grievances ALTER COLUMN id SET DEFAULT nextval('public.bd_grievances_id_seq'::regclass);


--
-- Name: bd_meetings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_meetings ALTER COLUMN id SET DEFAULT nextval('public.bd_meetings_id_seq'::regclass);


--
-- Name: bd_queries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_queries ALTER COLUMN id SET DEFAULT nextval('public.bd_queries_id_seq'::regclass);


--
-- Name: boms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boms ALTER COLUMN id SET DEFAULT nextval('public.boms_id_seq'::regclass);


--
-- Name: client_appointments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_appointments ALTER COLUMN id SET DEFAULT nextval('public.client_appointments_id_seq'::regclass);


--
-- Name: client_developments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_developments ALTER COLUMN id SET DEFAULT nextval('public.client_developments_id_seq'::regclass);


--
-- Name: client_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_orders ALTER COLUMN id SET DEFAULT nextval('public.client_orders_id_seq'::regclass);


--
-- Name: client_queries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_queries ALTER COLUMN id SET DEFAULT nextval('public.client_queries_id_seq'::regclass);


--
-- Name: composite_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.composite_items ALTER COLUMN id SET DEFAULT nextval('public.composite_items_id_seq'::regclass);


--
-- Name: customization_packaging_options id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customization_packaging_options ALTER COLUMN id SET DEFAULT nextval('public.customization_packaging_options_id_seq'::regclass);


--
-- Name: customizations custom_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customizations ALTER COLUMN custom_id SET DEFAULT nextval('public.customizations_custom_id_seq'::regclass);


--
-- Name: departments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments ALTER COLUMN id SET DEFAULT nextval('public.departments_id_seq'::regclass);


--
-- Name: enquiries enquiry_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enquiries ALTER COLUMN enquiry_id SET DEFAULT nextval('public.enquiries_enquiry_id_seq'::regclass);


--
-- Name: facility_areas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_areas ALTER COLUMN id SET DEFAULT nextval('public.facility_areas_id_seq'::regclass);


--
-- Name: fulfillment_batch_splits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_splits ALTER COLUMN id SET DEFAULT nextval('public.fulfillment_batch_splits_id_seq'::regclass);


--
-- Name: fulfillment_batch_stage_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_stage_logs ALTER COLUMN id SET DEFAULT nextval('public.fulfillment_batch_stage_logs_id_seq'::regclass);


--
-- Name: fulfillment_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_comments ALTER COLUMN id SET DEFAULT nextval('public.fulfillment_comments_id_seq'::regclass);


--
-- Name: fulfillment_invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_invoices ALTER COLUMN id SET DEFAULT nextval('public.fulfillment_invoices_id_seq'::regclass);


--
-- Name: fulfillment_order_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_order_items ALTER COLUMN id SET DEFAULT nextval('public.fulfillment_order_items_id_seq'::regclass);


--
-- Name: fulfillment_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders ALTER COLUMN id SET DEFAULT nextval('public.fulfillment_orders_id_seq'::regclass);


--
-- Name: fulfillment_sla_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_sla_templates ALTER COLUMN id SET DEFAULT nextval('public.fulfillment_sla_templates_id_seq'::regclass);


--
-- Name: goods_received_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes ALTER COLUMN id SET DEFAULT nextval('public.goods_received_notes_id_seq'::regclass);


--
-- Name: item_dedicated_facility_locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations ALTER COLUMN id SET DEFAULT nextval('public.item_dedicated_facility_locations_id_seq'::regclass);


--
-- Name: item_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_groups ALTER COLUMN id SET DEFAULT nextval('public.item_groups_id_seq'::regclass);


--
-- Name: item_list_tiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_list_tiers ALTER COLUMN id SET DEFAULT nextval('public.item_list_tiers_id_seq'::regclass);


--
-- Name: item_list_vendor_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_list_vendor_rates ALTER COLUMN id SET DEFAULT nextval('public.item_list_vendor_rates_id_seq'::regclass);


--
-- Name: items_list id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items_list ALTER COLUMN id SET DEFAULT nextval('public.items_list_id_seq'::regclass);


--
-- Name: items_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items_master ALTER COLUMN id SET DEFAULT nextval('public.items_master_id_seq'::regclass);


--
-- Name: logistics_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_schedules ALTER COLUMN id SET DEFAULT nextval('public.logistics_schedules_id_seq'::regclass);


--
-- Name: master_approval_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_approval_status_history ALTER COLUMN id SET DEFAULT nextval('public.master_approval_status_history_id_seq'::regclass);


--
-- Name: material_request_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_request_notes ALTER COLUMN id SET DEFAULT nextval('public.material_request_notes_id_seq'::regclass);


--
-- Name: module_definitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_definitions ALTER COLUMN id SET DEFAULT nextval('public.module_definitions_id_seq'::regclass);


--
-- Name: newdevelopments product_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newdevelopments ALTER COLUMN product_id SET DEFAULT nextval('public.newdevelopments_product_id_seq'::regclass);


--
-- Name: order_items order_item_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items ALTER COLUMN order_item_id SET DEFAULT nextval('public.order_items_order_item_id_seq'::regclass);


--
-- Name: orders order_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders ALTER COLUMN order_id SET DEFAULT nextval('public.orders_order_id_seq'::regclass);


--
-- Name: pack_materials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_materials ALTER COLUMN id SET DEFAULT nextval('public.pack_materials_id_seq'::regclass);


--
-- Name: packaging id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packaging ALTER COLUMN id SET DEFAULT nextval('public.packaging_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);


--
-- Name: permissions permission_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions ALTER COLUMN permission_id SET DEFAULT nextval('public.permissions_permission_id_seq'::regclass);


--
-- Name: planning_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_batches ALTER COLUMN id SET DEFAULT nextval('public.planning_batches_id_seq'::regclass);


--
-- Name: planning_bom_override id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_bom_override ALTER COLUMN id SET DEFAULT nextval('public.planning_bom_override_id_seq'::regclass);


--
-- Name: planning_extracted id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_extracted ALTER COLUMN id SET DEFAULT nextval('public.planning_extracted_id_seq'::regclass);


--
-- Name: planning_quotation_asks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_quotation_asks ALTER COLUMN id SET DEFAULT nextval('public.planning_quotation_asks_id_seq'::regclass);


--
-- Name: po_tracking id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_tracking ALTER COLUMN id SET DEFAULT nextval('public.po_tracking_id_seq'::regclass);


--
-- Name: procurement_quotations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_quotations ALTER COLUMN id SET DEFAULT nextval('public.procurement_quotations_id_seq'::regclass);


--
-- Name: procurement_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_requests ALTER COLUMN id SET DEFAULT nextval('public.procurement_requests_id_seq'::regclass);


--
-- Name: product_customizations customization_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_customizations ALTER COLUMN customization_id SET DEFAULT nextval('public.product_customizations_customization_id_seq'::regclass);


--
-- Name: production_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_batches ALTER COLUMN id SET DEFAULT nextval('public.production_batches_id_seq'::regclass);


--
-- Name: production_equipment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_equipment ALTER COLUMN id SET DEFAULT nextval('public.production_equipment_id_seq'::regclass);


--
-- Name: production_team_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_team_members ALTER COLUMN id SET DEFAULT nextval('public.production_team_members_id_seq'::regclass);


--
-- Name: products product_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products ALTER COLUMN product_id SET DEFAULT nextval('public.products_product_id_seq'::regclass);


--
-- Name: purchase_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders ALTER COLUMN id SET DEFAULT nextval('public.purchase_orders_id_seq'::regclass);


--
-- Name: quote_actuals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_actuals ALTER COLUMN id SET DEFAULT nextval('public.quote_actuals_id_seq'::regclass);


--
-- Name: quote_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_audit_log ALTER COLUMN id SET DEFAULT nextval('public.quote_audit_log_id_seq'::regclass);


--
-- Name: quote_category_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_category_rates ALTER COLUMN id SET DEFAULT nextval('public.quote_category_rates_id_seq'::regclass);


--
-- Name: quote_conversion_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_conversion_rates ALTER COLUMN id SET DEFAULT nextval('public.quote_conversion_rates_id_seq'::regclass);


--
-- Name: quote_dispatch_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_dispatch_config ALTER COLUMN id SET DEFAULT nextval('public.quote_dispatch_config_id_seq'::regclass);


--
-- Name: quote_emails id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_emails ALTER COLUMN id SET DEFAULT nextval('public.quote_emails_id_seq'::regclass);


--
-- Name: quote_grades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_grades ALTER COLUMN id SET DEFAULT nextval('public.quote_grades_id_seq'::regclass);


--
-- Name: quote_manufacturing_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_manufacturing_rules ALTER COLUMN id SET DEFAULT nextval('public.quote_manufacturing_rules_id_seq'::regclass);


--
-- Name: quote_overheads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_overheads ALTER COLUMN id SET DEFAULT nextval('public.quote_overheads_id_seq'::regclass);


--
-- Name: quote_procurement_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_procurement_rules ALTER COLUMN id SET DEFAULT nextval('public.quote_procurement_rules_id_seq'::regclass);


--
-- Name: quote_qc_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_qc_rules ALTER COLUMN id SET DEFAULT nextval('public.quote_qc_rules_id_seq'::regclass);


--
-- Name: raw_materials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_materials ALTER COLUMN id SET DEFAULT nextval('public.raw_materials_id_seq'::regclass);


--
-- Name: refreshTokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."refreshTokens" ALTER COLUMN id SET DEFAULT nextval('public."refreshTokens_id_seq"'::regclass);


--
-- Name: reserved_batch_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserved_batch_items ALTER COLUMN id SET DEFAULT nextval('public.reserved_batch_items_id_seq'::regclass);


--
-- Name: roles role_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN role_id SET DEFAULT nextval('public.roles_role_id_seq'::regclass);


--
-- Name: sales_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_orders ALTER COLUMN id SET DEFAULT nextval('public.sales_orders_id_seq'::regclass);


--
-- Name: saved_quotes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_quotes ALTER COLUMN id SET DEFAULT nextval('public.saved_quotes_id_seq'::regclass);


--
-- Name: shipment_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_batches ALTER COLUMN id SET DEFAULT nextval('public.shipment_batches_id_seq'::regclass);


--
-- Name: transporters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transporters ALTER COLUMN id SET DEFAULT nextval('public.transporters_id_seq'::regclass);


--
-- Name: universal_swap_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.universal_swap_history ALTER COLUMN id SET DEFAULT nextval('public.universal_swap_history_id_seq'::regclass);


--
-- Name: users userid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN userid SET DEFAULT nextval('public.users_userid_seq'::regclass);


--
-- Name: vendor_clients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_clients ALTER COLUMN id SET DEFAULT nextval('public.vendor_clients_id_seq'::regclass);


--
-- Name: warehouse_inventory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory ALTER COLUMN id SET DEFAULT nextval('public.warehouse_inventory_id_seq'::regclass);


--
-- Name: warehouse_inventory_location_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory_location_history ALTER COLUMN id SET DEFAULT nextval('public.warehouse_inventory_location_history_id_seq'::regclass);


--
-- Name: warehouse_locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_locations ALTER COLUMN id SET DEFAULT nextval('public.warehouse_locations_id_seq'::regclass);


--
-- Name: warehouse_rack_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_rack_items ALTER COLUMN id SET DEFAULT nextval('public.warehouse_rack_items_id_seq'::regclass);


--
-- Name: warehouse_racks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_racks ALTER COLUMN id SET DEFAULT nextval('public.warehouse_racks_id_seq'::regclass);


--
-- Data for Name: addresses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.addresses (address_id, user_id, address_type, is_default_shipping, is_default_billing, first_name, last_name, address_line1, address_line2, landmark, city_text, state_text, country_text, pincode, updated_at, phone, email, deleted_at, lifecycle_status, created_at) FROM stdin;
1	1	billing	f	f	Pipe	User	1 Test Street	\N	\N	Test City	Test State	IN	000000	2026-07-03 13:36:48.394+00	\N	\N	\N	active	2026-07-03 13:36:48.394+00
2	1	shipping	f	f	Pipe	User	2 Test Avenue	\N	\N	Test City	Test State	IN	000000	2026-07-03 13:36:48.395+00	\N	\N	\N	active	2026-07-03 13:36:48.395+00
3	2	billing	f	t	Sarah	Smith	Wellness Dermatology	\N	\N	Mumbai	Maharashtra	India	400050	2026-07-03 13:37:21.858+00	+919988776655	\N	\N	active	2026-07-03 13:37:21.858+00
4	2	shipping	t	f	Sarah	Smith	Suite 405, Health Plaza, Bandra West	\N	\N	Mumbai	Maharashtra	India	400050	2026-07-03 13:37:21.86+00	+919988776655	\N	\N	active	2026-07-03 13:37:21.86+00
5	3	billing	f	t	Raj	Kapoor	SkinCare Plus Clinic	\N	\N	New Delhi	Delhi	India	110001	2026-07-03 13:37:21.924+00	+919876543301	\N	\N	active	2026-07-03 13:37:21.924+00
6	3	shipping	t	f	Raj	Kapoor	12, Connaught Place, Block C	\N	\N	New Delhi	Delhi	India	110001	2026-07-03 13:37:21.925+00	+919876543301	\N	\N	active	2026-07-03 13:37:21.925+00
7	4	billing	f	t	Priya	Menon	Glow Dermatology Centre	\N	\N	Bengaluru	Karnataka	India	560038	2026-07-03 13:37:21.988+00	+919876543302	\N	\N	active	2026-07-03 13:37:21.988+00
8	4	shipping	t	f	Priya	Menon	88, MG Road, Indiranagar	\N	\N	Bengaluru	Karnataka	India	560038	2026-07-03 13:37:21.989+00	+919876543302	\N	\N	active	2026-07-03 13:37:21.989+00
9	5	billing	f	t	Amit	Verma	Chennai Skin Institute	\N	\N	Chennai	Tamil Nadu	India	600017	2026-07-03 13:37:22.051+00	+919876543303	\N	\N	active	2026-07-03 13:37:22.051+00
10	5	shipping	t	f	Amit	Verma	45, Anna Salai, T Nagar	\N	\N	Chennai	Tamil Nadu	India	600017	2026-07-03 13:37:22.053+00	+919876543303	\N	\N	active	2026-07-03 13:37:22.053+00
\.


--
-- Data for Name: appointments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.appointments (appointmentid, app_id, app_type, app_doc_name, app_doc_mobile, app_doc_email, app_clinic_name, app_address1, app_address2, app_state, app_city, app_other_address, app_pincode, app_date1, app_date1_time_slot1, app_date2, app_date2_time_slot2, app_status, app_remarks, app_userid, confirm_appointment, app_confirmation_status, meeting_status, mom, assign_to, pex_id, adedon, user_id, doctor_id, clinic_name, email, phone, address, city, state, pincode, reason, mode, status, slot1_date, slot1_time, slot2_date, slot2_time, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: authentication; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.authentication (id, user_id, phone, otp, expired, created) FROM stdin;
\.


--
-- Data for Name: bd_client_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bd_client_profiles (id, client_id, tier, tier_source, bd_lifecycle, lifecycle_source, bd_poc_id, onboarded_date, credit_limit, agreement_name, agreement_expires_on, notes, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: bd_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bd_events (id, client_id, type, title, body, ref_type, ref_id, actor_id, actor_name, source, occurred_at, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: bd_grievances; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bd_grievances (id, client_id, code, origin, related_type, related_ref, related_info, severity, category, description, assignee_id, assignee_name, status, escalated_dept, escalated_to_id, escalated_to_name, escalation_note, internal_reply, root_cause, corrective_action, customer_confirmed, response, source_channel, sla_target_hours, responded_at, resolved_at, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: bd_meetings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bd_meetings (id, client_id, code, origin, requested_at, scheduled_for, old_scheduled_for, mode, type, assignee_id, assignee_name, attendees, status, agenda, mom, action_items, next_meeting_at, attended_at, closed_at, cancelled_at, cancel_reason, related_type, related_ref, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: bd_queries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bd_queries (id, client_id, code, origin, related_type, related_ref, related_info, subject, description, assignee_id, assignee_name, status, escalated_dept, escalated_to_id, escalated_to_name, escalation_note, internal_reply, response, source_channel, sla_target_hours, responded_at, resolved_at, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: boms; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.boms (id, bom_code, bom_sku, zoho_id, bom_category, bom_unit, bom_hsn, bom_tax_preference, bom_returnable, bom_associate_items, bom_composite_item, type, status, version, client, name, dosage, pack_size, site, category, claims, project, market, created_by, reviewed_by, "desc", spec_bulk, spec_process, spec_fg, spec_pack, spec_tests, spec_release, batch, yield_pct, overage, line, notes, regulatory, ph_range, description, rm_lines, sku_rm_lines, sku_bom_limit_qty, sku_bom_limit_uom, pm_lines, process_steps, stability_summary, product_id, created_at, updated_at, deleted_at, lifecycle_status, pr_facility_licences) FROM stdin;
1	BOM-PIPE-001	\N	\N	\N	\N	\N	\N	\N	\N	t	\N	\N	\N	\N	Pipe BOM	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	[{"rm_code":"EI-RM-ACT-PIPE-001","pct_w_w":100,"uom":"KG","specific_gravity":1}]	\N	\N	\N	[{"pm_code":"EI-PM-PKG-PIPE-001","qty_per_unit":1,"uom":"PCS"}]	\N	\N	1	2026-07-03 13:36:48.388+00	2026-07-03 13:36:48.388+00	\N	active	\N
\.


--
-- Data for Name: client_appointments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.client_appointments (id, client_id, title, appointment_date, appointment_time, type, with_person, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: client_developments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.client_developments (id, client_id, pr_code, name, stage, status, due_date, phase, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: client_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.client_orders (id, client_id, product_name, quantity, status, due_date, batch_code, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: client_queries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.client_queries (id, client_id, title, status, due_date, category, notes, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: composite_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.composite_items (id, composite_item_id, composite_item_name, sales_description) FROM stdin;
\.


--
-- Data for Name: contacts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.contacts (contact_id, created_time, notes) FROM stdin;
\.


--
-- Data for Name: customization_packaging_options; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customization_packaging_options (id, option_id, title, subtitle, review_label, sku_code, is_custom, sort_order, active, specs, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	bottle_30ml_dropper	30 ml	Glass / PP · dropper	30 ml dropper bottle	EI-PK-30-DP	f	10	t	{"skuVol":"30 ml","material":"Glass / PP","color":"Frosted clear / White","pantone":"—","dispensing":"Glass dropper 0.6 ml","pumpMaterial":"Glass / PE","pumpColor":"Clear / White","capMaterial":"PP","capColor":"White","moq":100}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
2	bottle_50ml_pump	50 ml	Airless-style pump	50 ml pump bottle	EI-PK-50-PMP	f	20	t	{"skuVol":"50 ml","material":"PP / PET","color":"White / Natural","pantone":"Custom on request","dispensing":"0.2 ml / stroke","pumpMaterial":"PP","pumpColor":"White","capMaterial":"PP overcap","capColor":"White","moq":100}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
3	bottle_100ml_pump	100 ml	Treatment pump	100 ml pump bottle	EI-PK-100-PMP	f	30	t	{"skuVol":"100 ml","material":"PET / PP","color":"White","pantone":"—","dispensing":"0.25 ml / stroke","pumpMaterial":"PP","pumpColor":"White","capMaterial":"PP","capColor":"White","moq":100}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
4	airless_15ml	15 ml	Airless pump	15 ml airless	EI-PK-15-AL	f	40	t	{"skuVol":"15 ml","material":"PP / AS","color":"White / Silver collar","pantone":"—","dispensing":"0.15 ml / stroke","pumpMaterial":"PP","pumpColor":"White","capMaterial":"PP","capColor":"White","moq":200}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
5	airless_30ml	30 ml	Airless pump	30 ml airless	EI-PK-30-AL	f	50	t	{"skuVol":"30 ml","material":"PP / AS","color":"White / Silver collar","pantone":"—","dispensing":"0.2 ml / stroke","pumpMaterial":"PP","pumpColor":"White","capMaterial":"PP","capColor":"White","moq":200}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
6	jar_30g	30 g	Cream jar · double-wall	30 g cream jar	EI-PK-30-JR	f	60	t	{"skuVol":"30 g","material":"PP / PET","color":"White","pantone":"—","dispensing":"—","pumpMaterial":"—","pumpColor":"—","capMaterial":"PP","capColor":"White","moq":150}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
7	jar_50g	50 g	Cream jar	50 g cream jar	EI-PK-50-JR	f	70	t	{"skuVol":"50 g","material":"PP / Glass","color":"White / Clear","pantone":"—","dispensing":"—","pumpMaterial":"—","pumpColor":"—","capMaterial":"PP","capColor":"White","moq":150}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
8	tube_50ml	50 ml	Laminate tube	50 ml tube	EI-PK-50-TB	f	80	t	{"skuVol":"50 ml","material":"ABL / PE","color":"White","pantone":"Print artwork","dispensing":"Flip-top / screw cap","pumpMaterial":"PE","pumpColor":"White","capMaterial":"PP","capColor":"White","moq":300}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
9	tube_100ml	100 ml	Laminate tube	100 ml tube	EI-PK-100-TB	f	90	t	{"skuVol":"100 ml","material":"ABL / PE","color":"White","pantone":"Print artwork","dispensing":"Flip-top","pumpMaterial":"PE","pumpColor":"White","capMaterial":"PP","capColor":"White","moq":300}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
10	spray_100ml	100 ml	Fine mist spray	100 ml spray bottle	EI-PK-100-SPR	f	100	t	{"skuVol":"100 ml","material":"PET / PP","color":"Clear / White","pantone":"—","dispensing":"Fine mist 0.12 ml","pumpMaterial":"PP","pumpColor":"White","capMaterial":"PP","capColor":"Clear hood","moq":150}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
11	custom	Custom	Upload your own pack specs	Custom packaging (upload / brief)	CUSTOM	t	1000	t	{"skuVol":"—","material":"Per your brief","color":"—","pantone":"—","dispensing":"—","pumpMaterial":"—","pumpColor":"—","capMaterial":"—","capColor":"—","moq":0}	2026-07-03 13:38:53.202+00	2026-07-03 13:38:53.202+00	\N	active
\.


--
-- Data for Name: customizations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customizations (custom_id, name, concentration, description, active_composition, indications, how_to_use, specifications, cautions, frequently_asked_questions, category, incredients, care, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: departments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.departments (id, name, code, is_active, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: doctor_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.doctor_profiles (user_id, doctor_id, clinic_name, clinic_address, city, state, country, pincode, deleted_at, lifecycle_status, created_at, updated_at) FROM stdin;
2	DOC-SAR-101	Wellness Dermatology	Suite 405, Health Plaza, Bandra West	Mumbai	Maharashtra	India	400050	\N	active	2026-07-03 13:37:21.855+00	2026-07-03 13:37:21.855+00
3	DOC-RAJ-102	SkinCare Plus Clinic	12, Connaught Place, Block C	New Delhi	Delhi	India	110001	\N	active	2026-07-03 13:37:21.922+00	2026-07-03 13:37:21.922+00
4	DOC-PRI-103	Glow Dermatology Centre	88, MG Road, Indiranagar	Bengaluru	Karnataka	India	560038	\N	active	2026-07-03 13:37:21.986+00	2026-07-03 13:37:21.986+00
5	DOC-AMI-104	Chennai Skin Institute	45, Anna Salai, T Nagar	Chennai	Tamil Nadu	India	600017	\N	active	2026-07-03 13:37:22.049+00	2026-07-03 13:37:22.049+00
\.


--
-- Data for Name: enquiries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.enquiries (enquiry_id, ticket_number, user_id, customer, subject, description, category, priority, status, source, ticket_scope, collaboration, tags, current_assignee, assignment_history, linked_orders, messages, activities, first_response_at, sla_deadline, resolved_at, resolution_notes, response_count, created_at, updated_at, enquiry_type, details, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: facility_areas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.facility_areas (id, code, name, area_type, icon, description, zoho_location_id, zoho_meta, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: fulfillment_batch_splits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fulfillment_batch_splits (id, fulfillment_order_item_id, fulfillment_order_id, production_batch_id, bmr_no, bpr_no, planned_qty, fg_qty, fg_location, ff_status, picked_qty, picker_name, pick_date, pick_slip_no, remarks, invoice_no, awb_no, courier, dispatch_date, eta_date, delivery_date, received_by, delivery_remarks, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	1	1	1	BMR-2026-001	BPR-2026-001	30	0	\N	picking	30	Picker 1	2026-03-22	SLIP-1	Pick OK	\N	\N	\N	\N	\N	\N	\N	\N	2026-07-03 13:36:48.405+00	2026-07-03 13:36:48.566+00	\N	active
\.


--
-- Data for Name: fulfillment_batch_stage_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fulfillment_batch_stage_logs (id, fulfillment_batch_split_id, fulfillment_order_id, stage, started_at, completed_at, actor_name, actor_user_id, committed_days, created_at, updated_at) FROM stdin;
1	1	1	picking	2026-07-03 13:36:48.569+00	\N	Picker 1	\N	2.0	2026-07-03 13:36:48.569+00	2026-07-03 13:36:48.569+00
\.


--
-- Data for Name: fulfillment_comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fulfillment_comments (id, entity_type, entity_id, by_user_id, by_user_name, text, tagged_users, attachments, resolved, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: fulfillment_invoices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fulfillment_invoices (id, invoice_no, fulfillment_order_id, invoice_date, due_date, prepared_by, transporter_id, transporter_name, lr_awb_no, remarks, subtotal, gst_percent, total_value, status, line_items, zoho_invoice_id, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: fulfillment_order_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fulfillment_order_items (id, fulfillment_order_id, item_no, sku, product_code, product_name, pack, ordered_qty, rate, unit_price, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	1	1	SKU-FG-PIPE-001	\N	FG Pipe Product	PCS	30	0.00	0.00	2026-07-03 13:36:48.404+00	2026-07-03 13:36:48.404+00	\N	active
\.


--
-- Data for Name: fulfillment_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fulfillment_orders (id, so_no, sales_order_id, customer_name, customer_city, order_date, due_date, priority, so_status, so_value, ship_address, payment_terms, notes, zoho_invoice_id, invoice_no, invoice_date, awb_no, dispatch_date, courier, commercial_status, on_hold_previous_status, vendor_client_id, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	EI-SO-2026-001	\N	Pipe Customer	Test City	2026-03-20	2026-03-30	normal	picking	0.00	\N	\N	\N	\N	\N	\N	\N	\N	\N	received	\N	\N	2026-07-03 13:36:48.402+00	2026-07-03 13:36:48.571+00	\N	active
\.


--
-- Data for Name: fulfillment_sla_templates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fulfillment_sla_templates (id, product_id, stage, committed_days, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: goods_received_notes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.goods_received_notes (id, grn_no, purchase_order_id, po_no, vendor, type, items, po_value, expected_date, received_date, assigned_to, qc_status, qc_by, qc_specs, status, shipment_batch_id, stage, shipped_qty, line_items, workflow_steps, invoice_no, invoice_amount, grn_date, no_of_boxes, units_per_box, last_box_units, location_prefix, location_zone, grn_batch_mfg, expiry, mfg_batch, generated_labels, receipt_source, source_documents, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	GRN-PIPE-001	\N	\N	\N	RM	0	\N	\N	\N	\N	\N	\N	\N	GRN Complete	\N	\N	\N	[{"raw_material_id":1,"rcvdQty":30}]	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	po	\N	2026-07-03 13:36:48.407+00	2026-07-03 13:36:48.407+00	\N	active
2	GRN-PIPE-002	\N	\N	\N	PM	0	\N	\N	\N	\N	\N	\N	\N	GRN Complete	\N	\N	\N	[{"pack_material_id":1,"rcvdQty":30}]	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	po	\N	2026-07-03 13:36:48.408+00	2026-07-03 13:36:48.408+00	\N	active
\.


--
-- Data for Name: item_dedicated_facility_locations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.item_dedicated_facility_locations (id, item_key, raw_material_id, pack_material_id, product_id, wh_location_id, wh_rack_id, prod_location_id, prod_rack_id, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: item_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.item_groups (id, code, icon, type, name, description, purpose, status, notes, member_ids, proposed_alternates, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: item_list_tiers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.item_list_tiers (id, item_list_vendor_rate_id, moq_min, moq_max, price_per_unit, valid_till, note, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: item_list_vendor_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.item_list_vendor_rates (id, items_list_id, vendor_id, party_type, default_rate, default_moq, lead_time_days, currency, payment_terms, status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.items (item_id, created_time, sales_description) FROM stdin;
\.


--
-- Data for Name: items_list; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.items_list (id, type, raw_material_id, pack_material_id, product_id, status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: items_master; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.items_master (id, code, name, type, status, bom_ids, raw_material_ids, pack_material_ids, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: logistics_schedules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.logistics_schedules (id, tracking_no, transporter, dispatch_date, eta_date, vehicle_no, status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: master_approval_status_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.master_approval_status_history (id, master_kind, master_id, master_code, from_status, to_status, changed_by_user_id, changed_by_display_name, source, note, created_at) FROM stdin;
\.


--
-- Data for Name: material_request_notes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.material_request_notes (id, mrn_no, requested_by, status, assigned_picker, transfer_team, line_items, line_transfer_status, notes, bmr_no, source, is_inbound_from_mu, received_at_mu, generated_labels, no_of_boxes, units_per_box, location_prefix, grn_batch_mfg, expiry, mfg_batch, wh_dispatch_zone, mu_receive_zone, mu_receive_rack, required_by_date, logistics_tracking_no, logistics_transporter, logistics_dispatch_date, logistics_eta_date, logistics_vehicle_no, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	MRN-PIPE-001	\N	Completed	\N	\N	[{"raw_material_id":1,"quantity":30,"unit":"KG"},{"pack_material_id":1,"quantity":30,"unit":"PCS"}]	{"m1":"completed","m2":"completed"}	\N	BMR-2026-001	MTR	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	LOC-MU01	R1	\N	\N	\N	\N	\N	\N	2026-07-03 13:36:48.503+00	2026-07-03 13:36:48.506+00	\N	active
\.


--
-- Data for Name: module_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.module_definitions (id, name, definition_json, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: newdevelopments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.newdevelopments (product_id, user_id, status, customization, sale, hsn_code, product_status, product_code, generic_name, brand_name, super_category, product_category, sub_category, sub_sub_category, product_sku, label_claims, product_description_cust, product_description, product_price, tax_rate, gst_input, product_cover_image, product_cover_image_customization, product_ingrediants, excepients, indications, usage, cautions, application_area, dosage_form_type, phrange, color, fragrance, vascosity, other_specs, technology_used, recomendedproducts, packing_recommendations, batch_no, sub_cat_char, grid_sub_cat, skin_type, product_specializations, usage_time, application_specifications, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: order_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.order_items (order_item_id, order_id, product_id, sef_id, item_type, quantity, unit_price, discount_amount, tax_amount, line_total, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.orders (order_id, user_id, billing_address_id, shipping_address_id, order_status, payment_status, so_no, fulfillment_stage, subtotal, discount_total, tax_total, shipping_total, grand_total, advance_amount_due, deleted_at, lifecycle_status, created_at) FROM stdin;
1	1	1	2	pending	pending	EI-SO-2026-001	packaged	0.00	0.00	0.00	0.00	0.00	0.00	\N	active	2026-07-03 13:36:48.397+00
\.


--
-- Data for Name: pack_materials; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pack_materials (id, code, description, type, level, "group", material, size_spec, price_per_pc, moq, lead_time_days, print_status, approval_assigned_user_id, approval_assigned_display_name, approval_stage_assignees, products, zoho_id, zoho_sku_code, hsn_code, unit, tax_pref, pkg_returnable, pkg_associate_items, sales_purchase_account, form_data, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	EI-PM-PKG-PIPE-001	Pipe PM	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-07-03 13:36:48.385+00	2026-07-03 13:36:48.385+00	\N	active
\.


--
-- Data for Name: packaging; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.packaging (id, package_code, package_name, package_sku, bottom, cap_type, bottom_name, bottom_material, cap_name, cap_material, bottom_color, cap_color, bottom_weight, cap_weight, dispenser_volume, minimum_order_quantity, budget, comments, status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payments (id, "paymentId", "razorpayOrderId", gateway, "gatewayReference", "paidAmount", "remainingAmount", currency, status, deleted_at, lifecycle_status, "createdAt", "updatedAt", "orderOrderId", "UserUserid") FROM stdin;
\.


--
-- Data for Name: permissions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.permissions (permission_id, resource, action, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: planning_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planning_batches (id, planning_extracted_id, sequence, batch_code, size_kg, rm_lines, pm_lines, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: planning_bom_override; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planning_bom_override (id, planning_extracted_id, rm_lines, pm_lines, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: planning_extracted; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planning_extracted (id, sales_order_id, product_id, order_qty_display, total_kg_display, order_date, due_date, batch_size_display, batches_required, bom_status, approved_by, raw_materials, packaging_materials, color, batch_count, batch_size_kg, planned_start_date, production_line, bom_confirmed_at, bom_specific_gravity, custom_batches, sent_batch_indices, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: planning_quotation_asks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.planning_quotation_asks (id, planning_extracted_id, item_type, raw_material_id, pack_material_id, item_code, item_name, quantity_requested, unit, vendor_hint, moq_hint, status, notes, requested_by, fulfilled_at, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: po_tracking; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.po_tracking (id, purchase_order_id, po_released_at, po_released_note, advance_paid_at, advance_paid_note, payment_transaction_no, payment_mode, payment_transaction_date, vendor_confirmed_at, vendor_confirmed_note, shipped_at, shipped_note, order_tracking_ref, delivered_at, delivered_note, under_grn_at, under_grn_note, grn_complete_at, grn_complete_note, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: procurement_quotations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.procurement_quotations (id, procurement_request_id, vendor_id, quote_date, quoted_by, attachment_ref, attachment_status, items, lead_time_days, payment_terms, valid_till, total_value, notes, status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: procurement_requests; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.procurement_requests (id, planning_extracted_id, planning_batch_id, priority, required_by_date, notes, items, status, preferred_vendor, requested_by, stock_check_assigned_to, stock_check_status, stock_check_due_date, stock_check_notes, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: product_customizations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.product_customizations (customization_id, user_id, product_id, category, formulation, "formulationSummary", care, "packagingType", packaging_image, "userNotes", packaging, status, assigned_bd_user_id, assigned_bd_name, assigned_bd_email, assigned_at, internal_notes, life_cycle_status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: production_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.production_batches (id, bmr_no, bpr_no, product_name, sku, so_no, order_qty, batch_size, batch_no, batch_index, total_batches, planning_batch_id, bmr_status, bpr_status, color, process_type, homogenizer, main_vessel, supporting_tanks, filling_line, filling_type, packaging_line, monocarton, shrink, team_bmr, team_bpr, qc_officer_bmr, qc_officer_bpr, scheduled_mu_zone, schedule_remarks, mfg_date, fill_date, pack_date, fg_date, rm_connect_date, pm_connect_date, rm_reserved, pm_reserved, rm_connected, pm_connected, dispensing_rm, dispensing_pm, mu_dispensing_bundle_id, mu_dispensing_bundles, bulk_yield, fill_yield, fg_yield, bulk_batch_accepted, fill_batch_accepted, fg_batch_accepted, qc_specs, remarks, due_date, compatible_vessels, compatible_fill_lines, compatible_pack_lines, required_volume_liters, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	BMR-2026-001	BPR-2026-001	FG Pipe Product	SKU-FG-PIPE-001	EI-SO-2026-001	30	30	\N	1	1	\N	dispensing	fg_ready	\N	\N	f	\N	\N	\N	\N	\N	f	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	f	f	t	t	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-07-03 13:36:48.4+00	2026-07-03 13:36:48.554+00	\N	active
\.


--
-- Data for Name: production_equipment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.production_equipment (id, equipment_id, name, category, capacity, speed, type, homogenizer, process_types, compatible, supports, status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: production_team_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.production_team_members (id, member_id, user_id, name, role, department, available, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.products (product_id, status, availability, deleted_at, product_code, zoho_sku_code, generic_name, brand_name, tax_rate, product_description, incredients, how_to_use, created_at, updated_at, mrp_price, buy_price, product_name, commercial_name, category, lifecycle_status, form, fill_size, batch_size_kg, lead_time_days, shelf_life_months, version, license_cml, theoretical_yield_pct, pao_months, manufacturing_location, equipment_vessel, storage_conditions, approved_claims, ph_range, viscosity_range, spf_pa_rating, appearance, odour, fill_weight_spec, stability_summary, pr_record_type, zoho_item_id, approval_assigned_user_id, approval_assigned_display_name, approval_stage_assignees, approval_team_pending, form_data) FROM stdin;
1	Active	\N	\N	FG-PIPE-001	SKU-FG-PIPE-001	\N	\N	\N	\N	\N	\N	2026-07-03 13:36:48.387+00	2026-07-03 13:36:48.387+00	\N	\N	FG Pipe Product	\N	\N	\N	\N	\N	30	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N
\.


--
-- Data for Name: purchase_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_orders (id, order_id, vendor_name, branch, order_date, expected_shipment_date, reference, payment_terms, status, order_status, form_data, items, zoho_purchase_order_id, zoho_bill_id, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: quote_actuals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_actuals (id, bom_code, job_ref, pre_quote_id, post_quote_id, batch_size, yield_pct, actual_rm, actual_pm, actual_conversion, actual_overhead, actual_total, est_rm, est_pm, est_conversion, est_overhead, est_total, notes, entered_by, entered_by_name, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: quote_audit_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_audit_log (id, entity_type, entity_id, action, summary, changed_by, changed_by_name, created_at) FROM stdin;
\.


--
-- Data for Name: quote_category_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_category_rates (id, category, wastage_pct, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: quote_conversion_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_conversion_rates (id, packaging_type, moq_band, volume_key, rate, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: quote_dispatch_config; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_dispatch_config (id, grade_ref, dispatch_days, notes, created_at, updated_at) FROM stdin;
1	default	2	\N	2026-07-03 13:38:53.23+00	2026-07-03 13:38:53.23+00
\.


--
-- Data for Name: quote_emails; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_emails (id, quote_ref, to_email, cc_email, subject, status, error, message_id, created_at) FROM stdin;
\.


--
-- Data for Name: quote_grades; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_grades (id, name, description, moq_labels, moq_values, markups, zero_pm, bmap, qc_days, is_system, grade_ref, created_by, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	Grade 1 — Standard	Full-service, MOQ 500–25K	["500","1,000","2,500","5,000","10,000","15,000","25,000"]	[500,1000,2500,5000,10000,15000,25000]	[0.7,0.65,0.6,0.55,0.5,0.45,0.4]	f	[{"b":"1-1000","f":1.05},{"b":"1-1000","f":1},{"b":"1000-5000","f":1.05},{"b":"1000-5000","f":1},{"b":"5000-10000","f":1},{"b":"10000+","f":1},{"b":"10000+","f":0.92}]	5	t	system_1	\N	2026-07-03 13:38:53.212+00	2026-07-03 13:38:53.212+00	\N	active
2	Grade 2 — Moderate	Moderate margin (40→15%), MOQ 500–25K	["500","1,000","2,500","5,000","10,000","15,000","25,000"]	[500,1000,2500,5000,10000,15000,25000]	[0.4,0.35,0.32,0.28,0.25,0.2,0.15]	f	[{"b":"1-1000","f":1.05},{"b":"1-1000","f":1},{"b":"1000-5000","f":1.05},{"b":"1000-5000","f":1},{"b":"5000-10000","f":1},{"b":"10000+","f":1},{"b":"10000+","f":0.92}]	7	t	system_2	\N	2026-07-03 13:38:53.212+00	2026-07-03 13:38:53.212+00	\N	active
3	Grade 3 — Customer PPM	Customer supplies PM, margin 50→20%, MOQ 2K–50K	["2,000","5,000","10,000","15,000","25,000","35,000","50,000"]	[2000,5000,10000,15000,25000,35000,50000]	[0.5,0.45,0.4,0.35,0.3,0.25,0.2]	t	[{"b":"1000-5000","f":1.05},{"b":"1000-5000","f":1},{"b":"5000-10000","f":1},{"b":"10000+","f":1},{"b":"10000+","f":0.95},{"b":"10000+","f":0.92},{"b":"10000+","f":0.88}]	10	t	system_3	\N	2026-07-03 13:38:53.212+00	2026-07-03 13:38:53.212+00	\N	active
\.


--
-- Data for Name: quote_manufacturing_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_manufacturing_rules (id, product_type, product_subtype, band_index, manufacturing_days, cycle_time_days, notes, created_at, updated_at) FROM stdin;
1	serum		0	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
2	serum		1	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
3	serum		2	3	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
4	serum		3	4	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
5	serum		4	5	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
6	serum		5	7	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
7	serum		6	8	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
8	emulsion		0	1	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
9	emulsion		1	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
10	emulsion		2	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
11	emulsion		3	3	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
12	emulsion		4	4	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
13	emulsion		5	6	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
14	emulsion		6	7	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
15	wash		0	1	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
16	wash		1	1	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
17	wash		2	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
18	wash		3	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
19	wash		4	3	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
20	wash		5	4	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
21	wash		6	5	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
22	gel		0	1	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
23	gel		1	1	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
24	gel		2	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
25	gel		3	3	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
26	gel		4	4	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
27	gel		5	5	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
28	gel		6	6	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
29	general		0	1	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
30	general		1	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
31	general		2	2	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
32	general		3	3	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
33	general		4	4	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
34	general		5	5	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
35	general		6	6	\N	\N	2026-07-03 13:38:53.223+00	2026-07-03 13:38:53.223+00
\.


--
-- Data for Name: quote_overheads; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_overheads (id, product_category, head_name, band_values, sort_order, created_at, updated_at) FROM stdin;
1	all	In-Process QC	[0.8,0.7,0.55,0.45,0.35,0.3,0.25]	0	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
2	all	Final Product Testing	[0.5,0.4,0.35,0.3,0.25,0.2,0.15]	1	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
3	all	Stability & Micro Test	[0.4,0.35,0.25,0.2,0.15,0.12,0.1]	2	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
4	all	Material Handling	[0.5,0.4,0.35,0.3,0.25,0.2,0.15]	3	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
5	all	Warehousing & Storage	[0.5,0.4,0.3,0.25,0.2,0.15,0.12]	4	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
6	all	Dispatch & Loading	[0.35,0.3,0.25,0.2,0.15,0.12,0.1]	5	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
7	all	GMP / ISO Compliance	[0.25,0.2,0.15,0.12,0.1,0.08,0.06]	6	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
8	all	Batch Documentation	[0.2,0.18,0.15,0.12,0.1,0.08,0.06]	7	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
9	all	CoA & Regulatory	[0.15,0.12,0.1,0.08,0.06,0.05,0.04]	8	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
10	all	Working Capital Cost	[0.4,0.35,0.3,0.25,0.2,0.15,0.12]	9	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
11	all	Insurance	[0.15,0.12,0.1,0.08,0.06,0.05,0.04]	10	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
12	all	Admin & IT	[0.2,0.18,0.15,0.12,0.1,0.08,0.06]	11	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
13	all	In-Process Rejection	[0.35,0.3,0.25,0.2,0.15,0.12,0.1]	12	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
14	all	Sampling & Retention	[0.2,0.18,0.15,0.12,0.1,0.08,0.06]	13	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
15	all	Consumables	[0.15,0.12,0.1,0.08,0.06,0.05,0.04]	14	2026-07-03 13:38:53.215+00	2026-07-03 13:38:53.215+00
\.


--
-- Data for Name: quote_procurement_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_procurement_rules (id, material_type, category_or_material, individual_lead_days, batch_lead_days, notes, sort_order, created_at, updated_at) FROM stdin;
1	RM	Pre-mixed Bases	21	18	\N	0	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
2	RM	CLUB Items	14	12	\N	1	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
3	RM	Club Items	14	12	\N	2	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
4	RM	Bulk Raw Materials	12	10	\N	3	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
5	RM	Bulk raw materials	12	10	\N	4	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
6	RM	Raw Materials	12	10	\N	5	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
7	RM	Solvents & Carriers	10	8	\N	6	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
8	RM	DEFAULT	12	10	\N	7	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
9	PM	Packaging - Primary	18	15	\N	0	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
10	PM	Shrink Sleeves	16	14	\N	1	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
11	PM	Monocartons	12	10	\N	2	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
12	PM	Packaging - Secondary	12	10	\N	3	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
13	PM	Packing Material	10	9	\N	4	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
14	PM	Other Components	10	9	\N	5	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
15	PM	Labels	9	7	\N	6	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
16	PM	Stickers & Kits	9	7	\N	7	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
17	PM	DEFAULT	12	10	\N	8	2026-07-03 13:38:53.218+00	2026-07-03 13:38:53.218+00
\.


--
-- Data for Name: quote_qc_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quote_qc_rules (id, grade_ref, qc_days, notes, created_at, updated_at) FROM stdin;
1	system_1	5	\N	2026-07-03 13:38:53.228+00	2026-07-03 13:38:53.228+00
2	system_2	7	\N	2026-07-03 13:38:53.228+00	2026-07-03 13:38:53.228+00
3	system_3	10	\N	2026-07-03 13:38:53.228+00	2026-07-03 13:38:53.228+00
4	default	7	\N	2026-07-03 13:38:53.228+00	2026-07-03 13:38:53.228+00
\.


--
-- Data for Name: raw_materials; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.raw_materials (id, code, name, inci, category, rm_type, uom, price_per_kg, gst, shelf, specific_gravity, lead_time_days, status, approval_assigned_user_id, approval_assigned_display_name, approval_stage_assignees, products, "group", zoho_id, zoho_sku_code, hsn_code, tax_pref, sales_purchase_account, form_data, created_at, updated_at, deleted_at, lifecycle_status, master_lifecycle_status, rm_owner, universal_swap_eligibility, functional_equivalents) FROM stdin;
1	EI-RM-ACT-PIPE-001	Pipe RM	\N	\N	\N	\N	\N	\N	\N	\N	\N	Active	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-07-03 13:36:48.383+00	2026-07-03 13:36:48.383+00	\N	active	\N	\N	\N	\N
\.


--
-- Data for Name: refreshTokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."refreshTokens" (id, email, "refreshToken", "createdAt", "updatedAt") FROM stdin;
\.


--
-- Data for Name: reserved_batch_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.reserved_batch_items (id, production_batch_id, fulfillment_order_item_id, planning_extracted_id, raw_material_id, pack_material_id, quantity_reserved, unit, so_no, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: role_permissions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.role_permissions (role_id, permission_id) FROM stdin;
\.


--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.roles (role_id, role_code, role_name, description, level, status, permissions_json, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	doctor	Doctor	\N	staff	active	["dashboard"]	2026-07-03 13:37:21.782+00	2026-07-03 13:37:21.782+00	\N	active
\.


--
-- Data for Name: sales_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_orders (id, order_id, customer_name, branch, order_date, expected_shipment_date, reference, payment_terms, status, order_status, form_data, items, created_by, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: saved_quotes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.saved_quotes (id, quote_ref, quote_name, customer_name, bom_id, bom_code, grade, mode, payload, result, headline_sell, headline_moq, status, status_history, notes, gst_pct, valid_until, client_id, prepared_by, sales_order_id, sales_order_ref, version, root_quote_id, superseded_by, quote_type, quote_category, job_ref, pre_quote_id, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: shipment_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.shipment_batches (id, code, purchase_order_id, po_no, vendor, vehicle_no, driver_name, driver_phone, transporter, shipped_date, vendor_invoice_no, expected_arrival, total_qty, line_count, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: staff_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.staff_profiles (user_id, role_id, department, dep_level, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: transporters; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transporters (id, name, code, contact_phone, contact_email, tracking_url, status, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: universal_swap_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.universal_swap_history (id, from_raw_material_id, to_raw_material_id, swap_ratio, reason, approved_by, approved_by_user_id, affected_group_ids, affected_bom_ids, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (userid, fname, lname, display_name, email, mobile, password, usertype, portal_signup_role, department, status, doctor_id_legacy, verify_status, advance_payment, advance_amount, zoho_contact_id, created_at, updated_at, last_login_at, deleted_at, lifecycle_status) FROM stdin;
1	Pipe	User	\N	pipe_user@example.com	\N	x	admin	\N	\N	\N	\N	\N	f	\N	\N	2026-07-03 13:36:48.393+00	2026-07-03 13:36:48.393+00	\N	\N	active
2	Sarah	Smith	Dr. Sarah Smith	dr.sarah@example.com	+919988776655	$2b$10$eyDBryENPaIOe6Y8E7T1Iu1DksuexkmC.mt0rB/UuCHMUhK/WAb2m	doctor	dermatologist	\N	active	DOC-SAR-101	verified	f	\N	\N	2026-07-03 13:37:21.789+00	2026-07-03 13:37:21.789+00	\N	\N	active
3	Raj	Kapoor	Dr. Raj Kapoor	dr.raj@example.com	+919876543301	$2b$10$1wvpwj.SjdSNhcZB/1IIm.Vzbi8IyIoaUQh.U8vLiWsV3k.K0/4H.	doctor	dermatologist	\N	active	DOC-RAJ-102	verified	f	\N	\N	2026-07-03 13:37:21.862+00	2026-07-03 13:37:21.862+00	\N	\N	active
4	Priya	Menon	Dr. Priya Menon	dr.priya@example.com	+919876543302	$2b$10$sguEVMVZ4td1Gk2QMgeQLOCHW.3zDKWxbLqrp/lAJU5z5xsjAJKSS	doctor	dermatologist	\N	active	DOC-PRI-103	verified	f	\N	\N	2026-07-03 13:37:21.926+00	2026-07-03 13:37:21.926+00	\N	\N	active
5	Amit	Verma	Dr. Amit Verma	dr.amit@example.com	+919876543303	$2b$10$4V6ShX6tzVUXmIOqvdWWu.YNCfV583kxd28QIBnfsvsJJhhlHx8wS	doctor	dermatologist	\N	active	DOC-AMI-104	verified	f	\N	\N	2026-07-03 13:37:21.99+00	2026-07-03 13:37:21.99+00	\N	\N	active
\.


--
-- Data for Name: vendor_clients; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vendor_clients (id, entity_code, type, zoho_id, name, email, phone, location, country, city, category, status, payment_terms, notes, rating, moq, lead_time, data, priority, segment, since_year, revenue_value, avatar_color, account_manager_id, user_id, contacts, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: vendors; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vendors (contact_id, created_time, notes, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: warehouse_inventory; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouse_inventory (id, item_type, raw_material_id, pack_material_id, product_id, zone, rack, wh_stock, wh_unit, ml1_stock, ml2_stock, stock_in_hand, reserved, in_transit, reorder_pt, avg_mo, qc_status, batch_number, expiry_date, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
1	RM	1	\N	\N	\N	\N	30.0000000000000000	KG	0.0000000000000000	0.0000000000000000	30.0000000000000000	0.0000000000000000	0.0000000000000000	0.00	0.00	In Stock	\N	\N	2026-07-03 13:36:48.39+00	2026-07-03 13:36:48.525+00	\N	active
2	PM	\N	1	\N	\N	\N	30.0000000000000000	PCS	0.0000000000000000	0.0000000000000000	30.0000000000000000	0.0000000000000000	0.0000000000000000	0.00	0.00	In Stock	\N	\N	2026-07-03 13:36:48.392+00	2026-07-03 13:36:48.526+00	\N	active
\.


--
-- Data for Name: warehouse_inventory_location_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouse_inventory_location_history (id, warehouse_inventory_id, item_type, raw_material_id, pack_material_id, product_id, from_zone, from_rack, to_zone, to_rack, qty_delta, action_type, source_grn_id, source_mrn_id, moved_at, reserved_delta, reserved_after, production_batch_id, batch_no, dispensing_bundle_id, changes_json, note, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: warehouse_locations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouse_locations (id, area_id, code, name, location_type, zone_label, icon, area_sqm, description, utilisation_pct, zoho_warehouse_id, zoho_location_id, is_active, is_zoho_primary, is_default, zoho_meta, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: warehouse_rack_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouse_rack_items (id, rack_id, warehouse_inventory_id, qty_wh, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Data for Name: warehouse_racks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouse_racks (id, location_id, code, name, description, levels, slots_total, utilisation_pct, created_at, updated_at, deleted_at, lifecycle_status) FROM stdin;
\.


--
-- Name: addresses_address_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.addresses_address_id_seq', 10, true);


--
-- Name: appointments_appointmentid_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.appointments_appointmentid_seq', 1, false);


--
-- Name: authentication_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.authentication_id_seq', 1, false);


--
-- Name: bd_client_profiles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bd_client_profiles_id_seq', 1, false);


--
-- Name: bd_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bd_events_id_seq', 1, false);


--
-- Name: bd_grievances_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bd_grievances_id_seq', 1, false);


--
-- Name: bd_meetings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bd_meetings_id_seq', 1, false);


--
-- Name: bd_queries_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bd_queries_id_seq', 1, false);


--
-- Name: boms_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.boms_id_seq', 1, true);


--
-- Name: client_appointments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.client_appointments_id_seq', 1, false);


--
-- Name: client_developments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.client_developments_id_seq', 1, false);


--
-- Name: client_orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.client_orders_id_seq', 1, false);


--
-- Name: client_queries_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.client_queries_id_seq', 1, false);


--
-- Name: composite_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.composite_items_id_seq', 1, false);


--
-- Name: customization_packaging_options_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.customization_packaging_options_id_seq', 11, true);


--
-- Name: customizations_custom_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.customizations_custom_id_seq', 1, false);


--
-- Name: departments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.departments_id_seq', 1, false);


--
-- Name: enquiries_enquiry_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.enquiries_enquiry_id_seq', 1, false);


--
-- Name: facility_areas_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.facility_areas_id_seq', 1, false);


--
-- Name: fulfillment_batch_splits_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fulfillment_batch_splits_id_seq', 1, true);


--
-- Name: fulfillment_batch_stage_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fulfillment_batch_stage_logs_id_seq', 2, true);


--
-- Name: fulfillment_comments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fulfillment_comments_id_seq', 1, false);


--
-- Name: fulfillment_invoices_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fulfillment_invoices_id_seq', 1, false);


--
-- Name: fulfillment_order_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fulfillment_order_items_id_seq', 1, true);


--
-- Name: fulfillment_orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fulfillment_orders_id_seq', 1, true);


--
-- Name: fulfillment_sla_templates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fulfillment_sla_templates_id_seq', 1, false);


--
-- Name: goods_received_notes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.goods_received_notes_id_seq', 2, true);


--
-- Name: item_dedicated_facility_locations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.item_dedicated_facility_locations_id_seq', 1, false);


--
-- Name: item_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.item_groups_id_seq', 1, false);


--
-- Name: item_list_tiers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.item_list_tiers_id_seq', 1, false);


--
-- Name: item_list_vendor_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.item_list_vendor_rates_id_seq', 1, false);


--
-- Name: items_list_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.items_list_id_seq', 1, false);


--
-- Name: items_master_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.items_master_id_seq', 1, false);


--
-- Name: logistics_schedules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.logistics_schedules_id_seq', 1, false);


--
-- Name: master_approval_status_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.master_approval_status_history_id_seq', 1, false);


--
-- Name: material_request_notes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.material_request_notes_id_seq', 1, true);


--
-- Name: module_definitions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.module_definitions_id_seq', 1, false);


--
-- Name: newdevelopments_product_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.newdevelopments_product_id_seq', 1, false);


--
-- Name: order_items_order_item_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.order_items_order_item_id_seq', 1, false);


--
-- Name: orders_order_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.orders_order_id_seq', 1, true);


--
-- Name: pack_materials_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pack_materials_id_seq', 1, true);


--
-- Name: packaging_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.packaging_id_seq', 1, false);


--
-- Name: payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payments_id_seq', 1, false);


--
-- Name: permissions_permission_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.permissions_permission_id_seq', 1, false);


--
-- Name: planning_batches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.planning_batches_id_seq', 1, false);


--
-- Name: planning_bom_override_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.planning_bom_override_id_seq', 1, false);


--
-- Name: planning_extracted_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.planning_extracted_id_seq', 1, false);


--
-- Name: planning_quotation_asks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.planning_quotation_asks_id_seq', 1, false);


--
-- Name: po_tracking_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.po_tracking_id_seq', 1, false);


--
-- Name: procurement_quotations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.procurement_quotations_id_seq', 1, false);


--
-- Name: procurement_requests_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.procurement_requests_id_seq', 1, false);


--
-- Name: product_customizations_customization_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.product_customizations_customization_id_seq', 1, false);


--
-- Name: production_batches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.production_batches_id_seq', 1, true);


--
-- Name: production_equipment_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.production_equipment_id_seq', 1, false);


--
-- Name: production_team_members_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.production_team_members_id_seq', 1, false);


--
-- Name: products_product_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.products_product_id_seq', 1, true);


--
-- Name: purchase_orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.purchase_orders_id_seq', 1, false);


--
-- Name: quote_actuals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_actuals_id_seq', 1, false);


--
-- Name: quote_audit_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_audit_log_id_seq', 1, false);


--
-- Name: quote_category_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_category_rates_id_seq', 1, false);


--
-- Name: quote_conversion_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_conversion_rates_id_seq', 1, false);


--
-- Name: quote_dispatch_config_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_dispatch_config_id_seq', 1, true);


--
-- Name: quote_emails_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_emails_id_seq', 1, false);


--
-- Name: quote_grades_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_grades_id_seq', 3, true);


--
-- Name: quote_manufacturing_rules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_manufacturing_rules_id_seq', 35, true);


--
-- Name: quote_overheads_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_overheads_id_seq', 15, true);


--
-- Name: quote_procurement_rules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_procurement_rules_id_seq', 17, true);


--
-- Name: quote_qc_rules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quote_qc_rules_id_seq', 4, true);


--
-- Name: raw_materials_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.raw_materials_id_seq', 1, true);


--
-- Name: refreshTokens_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public."refreshTokens_id_seq"', 1, false);


--
-- Name: reserved_batch_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.reserved_batch_items_id_seq', 1, false);


--
-- Name: roles_role_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.roles_role_id_seq', 1, true);


--
-- Name: sales_orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sales_orders_id_seq', 1, false);


--
-- Name: saved_quotes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.saved_quotes_id_seq', 1, false);


--
-- Name: shipment_batches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.shipment_batches_id_seq', 1, false);


--
-- Name: transporters_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.transporters_id_seq', 1, false);


--
-- Name: universal_swap_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.universal_swap_history_id_seq', 1, false);


--
-- Name: users_userid_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_userid_seq', 5, true);


--
-- Name: vendor_clients_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.vendor_clients_id_seq', 1, false);


--
-- Name: warehouse_inventory_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.warehouse_inventory_id_seq', 2, true);


--
-- Name: warehouse_inventory_location_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.warehouse_inventory_location_history_id_seq', 1, false);


--
-- Name: warehouse_locations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.warehouse_locations_id_seq', 1, false);


--
-- Name: warehouse_rack_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.warehouse_rack_items_id_seq', 1, false);


--
-- Name: warehouse_racks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.warehouse_racks_id_seq', 1, false);


--
-- Name: addresses addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_pkey PRIMARY KEY (address_id);


--
-- Name: appointments appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (appointmentid);


--
-- Name: authentication authentication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authentication
    ADD CONSTRAINT authentication_pkey PRIMARY KEY (id);


--
-- Name: bd_client_profiles bd_client_profiles_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_client_profiles
    ADD CONSTRAINT bd_client_profiles_client_id_key UNIQUE (client_id);


--
-- Name: bd_client_profiles bd_client_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_client_profiles
    ADD CONSTRAINT bd_client_profiles_pkey PRIMARY KEY (id);


--
-- Name: bd_events bd_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_events
    ADD CONSTRAINT bd_events_pkey PRIMARY KEY (id);


--
-- Name: bd_grievances bd_grievances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_grievances
    ADD CONSTRAINT bd_grievances_pkey PRIMARY KEY (id);


--
-- Name: bd_meetings bd_meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_meetings
    ADD CONSTRAINT bd_meetings_pkey PRIMARY KEY (id);


--
-- Name: bd_queries bd_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_queries
    ADD CONSTRAINT bd_queries_pkey PRIMARY KEY (id);


--
-- Name: boms boms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boms
    ADD CONSTRAINT boms_pkey PRIMARY KEY (id);


--
-- Name: client_appointments client_appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_appointments
    ADD CONSTRAINT client_appointments_pkey PRIMARY KEY (id);


--
-- Name: client_developments client_developments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_developments
    ADD CONSTRAINT client_developments_pkey PRIMARY KEY (id);


--
-- Name: client_orders client_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_orders
    ADD CONSTRAINT client_orders_pkey PRIMARY KEY (id);


--
-- Name: client_queries client_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_queries
    ADD CONSTRAINT client_queries_pkey PRIMARY KEY (id);


--
-- Name: composite_items composite_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.composite_items
    ADD CONSTRAINT composite_items_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (contact_id);


--
-- Name: customization_packaging_options customization_packaging_options_option_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customization_packaging_options
    ADD CONSTRAINT customization_packaging_options_option_id_key UNIQUE (option_id);


--
-- Name: customization_packaging_options customization_packaging_options_option_id_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customization_packaging_options
    ADD CONSTRAINT customization_packaging_options_option_id_key1 UNIQUE (option_id);


--
-- Name: customization_packaging_options customization_packaging_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customization_packaging_options
    ADD CONSTRAINT customization_packaging_options_pkey PRIMARY KEY (id);


--
-- Name: customizations customizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customizations
    ADD CONSTRAINT customizations_pkey PRIMARY KEY (custom_id);


--
-- Name: departments departments_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_code_key UNIQUE (code);


--
-- Name: departments departments_code_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_code_key1 UNIQUE (code);


--
-- Name: departments departments_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_name_key UNIQUE (name);


--
-- Name: departments departments_name_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_name_key1 UNIQUE (name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: doctor_profiles doctor_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_profiles
    ADD CONSTRAINT doctor_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: enquiries enquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_pkey PRIMARY KEY (enquiry_id);


--
-- Name: enquiries enquiries_ticket_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_ticket_number_key UNIQUE (ticket_number);


--
-- Name: enquiries enquiries_ticket_number_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_ticket_number_key1 UNIQUE (ticket_number);


--
-- Name: facility_areas facility_areas_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_areas
    ADD CONSTRAINT facility_areas_code_key UNIQUE (code);


--
-- Name: facility_areas facility_areas_code_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_areas
    ADD CONSTRAINT facility_areas_code_key1 UNIQUE (code);


--
-- Name: facility_areas facility_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_areas
    ADD CONSTRAINT facility_areas_pkey PRIMARY KEY (id);


--
-- Name: facility_areas facility_areas_zoho_location_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_areas
    ADD CONSTRAINT facility_areas_zoho_location_id_key UNIQUE (zoho_location_id);


--
-- Name: facility_areas facility_areas_zoho_location_id_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_areas
    ADD CONSTRAINT facility_areas_zoho_location_id_key1 UNIQUE (zoho_location_id);


--
-- Name: fulfillment_batch_splits fulfillment_batch_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_splits
    ADD CONSTRAINT fulfillment_batch_splits_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_batch_stage_logs fulfillment_batch_stage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_stage_logs
    ADD CONSTRAINT fulfillment_batch_stage_logs_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_comments fulfillment_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_comments
    ADD CONSTRAINT fulfillment_comments_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_invoices fulfillment_invoices_invoice_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_invoices
    ADD CONSTRAINT fulfillment_invoices_invoice_no_key UNIQUE (invoice_no);


--
-- Name: fulfillment_invoices fulfillment_invoices_invoice_no_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_invoices
    ADD CONSTRAINT fulfillment_invoices_invoice_no_key1 UNIQUE (invoice_no);


--
-- Name: fulfillment_invoices fulfillment_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_invoices
    ADD CONSTRAINT fulfillment_invoices_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_order_items fulfillment_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_order_items
    ADD CONSTRAINT fulfillment_order_items_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_orders fulfillment_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_orders fulfillment_orders_so_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_so_no_key UNIQUE (so_no);


--
-- Name: fulfillment_orders fulfillment_orders_so_no_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_so_no_key1 UNIQUE (so_no);


--
-- Name: fulfillment_sla_templates fulfillment_sla_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_sla_templates
    ADD CONSTRAINT fulfillment_sla_templates_pkey PRIMARY KEY (id);


--
-- Name: goods_received_notes goods_received_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes
    ADD CONSTRAINT goods_received_notes_pkey PRIMARY KEY (id);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key1 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key10; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key10 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key100; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key100 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key101; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key101 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key102; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key102 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key103; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key103 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key104; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key104 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key105; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key105 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key106; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key106 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key107; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key107 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key108; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key108 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key109; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key109 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key11; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key11 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key110; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key110 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key111; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key111 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key112; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key112 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key113; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key113 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key114; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key114 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key115; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key115 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key116; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key116 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key117; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key117 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key118; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key118 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key119; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key119 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key12; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key12 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key120; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key120 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key121; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key121 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key122; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key122 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key123; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key123 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key124; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key124 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key125; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key125 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key126; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key126 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key127; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key127 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key128; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key128 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key129; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key129 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key13; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key13 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key130; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key130 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key131; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key131 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key132; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key132 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key133; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key133 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key134; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key134 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key135; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key135 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key136; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key136 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key137; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key137 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key138; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key138 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key139; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key139 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key14; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key14 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key140; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key140 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key141; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key141 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key142; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key142 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key143; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key143 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key144; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key144 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key145; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key145 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key146; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key146 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key147; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key147 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key148; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key148 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key149; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key149 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key15; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key15 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key150; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key150 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key151; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key151 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key152; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key152 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key153; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key153 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key154; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key154 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key155; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key155 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key156; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key156 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key157; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key157 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key158; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key158 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key159; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key159 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key16; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key16 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key160; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key160 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key161; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key161 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key162; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key162 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key163; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key163 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key164; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key164 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key165; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key165 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key166; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key166 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key167; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key167 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key168; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key168 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key169; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key169 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key17; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key17 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key170; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key170 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key171; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key171 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key172; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key172 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key173; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key173 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key174; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key174 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key175; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key175 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key176; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key176 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key177; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key177 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key178; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key178 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key179; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key179 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key18; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key18 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key180; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key180 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key181; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key181 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key182; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key182 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key183; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key183 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key184; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key184 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key185; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key185 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key186; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key186 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key187; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key187 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key188; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key188 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key189; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key189 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key19; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key19 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key190; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key190 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key191; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key191 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key192; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key192 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key193; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key193 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key194; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key194 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key195; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key195 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key196; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key196 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key197; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key197 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key198; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key198 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key199; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key199 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key2 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key20; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key20 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key200; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key200 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key201; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key201 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key202; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key202 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key203; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key203 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key204; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key204 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key205; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key205 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key206; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key206 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key207; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key207 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key208; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key208 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key209; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key209 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key21; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key21 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key210; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key210 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key211; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key211 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key212; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key212 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key213; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key213 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key214; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key214 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key215; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key215 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key216; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key216 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key217; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key217 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key218; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key218 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key219; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key219 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key22; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key22 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key220; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key220 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key221; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key221 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key222; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key222 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key223; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key223 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key224; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key224 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key225; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key225 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key226; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key226 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key227; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key227 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key228; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key228 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key229; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key229 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key23; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key23 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key230; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key230 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key231; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key231 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key232; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key232 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key233; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key233 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key234; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key234 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key235; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key235 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key236; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key236 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key237; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key237 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key238; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key238 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key239; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key239 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key24; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key24 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key240; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key240 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key241; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key241 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key242; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key242 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key243; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key243 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key244; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key244 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key245; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key245 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key246; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key246 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key247; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key247 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key248; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key248 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key249; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key249 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key25; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key25 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key250; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key250 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key251; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key251 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key252; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key252 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key253; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key253 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key254; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key254 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key255; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key255 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key256; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key256 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key257; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key257 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key258; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key258 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key259; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key259 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key26; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key26 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key260; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key260 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key261; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key261 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key262; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key262 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key263; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key263 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key264; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key264 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key265; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key265 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key266; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key266 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key267; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key267 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key268; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key268 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key269; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key269 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key27; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key27 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key270; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key270 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key271; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key271 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key272; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key272 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key273; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key273 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key274; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key274 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key275; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key275 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key276; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key276 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key277; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key277 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key278; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key278 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key279; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key279 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key28; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key28 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key280; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key280 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key281; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key281 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key282; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key282 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key283; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key283 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key284; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key284 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key285; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key285 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key286; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key286 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key287; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key287 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key288; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key288 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key289; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key289 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key29; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key29 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key290; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key290 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key291; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key291 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key292; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key292 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key293; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key293 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key294; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key294 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key295; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key295 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key296; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key296 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key297; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key297 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key298; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key298 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key299; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key299 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key3 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key30; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key30 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key300; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key300 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key301; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key301 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key302; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key302 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key303; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key303 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key304; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key304 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key305; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key305 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key306; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key306 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key307; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key307 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key308; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key308 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key309; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key309 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key31; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key31 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key310; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key310 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key311; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key311 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key312; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key312 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key313; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key313 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key314; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key314 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key315; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key315 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key316; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key316 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key317; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key317 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key318; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key318 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key319; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key319 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key32; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key32 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key320; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key320 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key321; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key321 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key322; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key322 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key323; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key323 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key324; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key324 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key325; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key325 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key326; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key326 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key327; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key327 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key328; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key328 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key329; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key329 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key33; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key33 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key330; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key330 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key331; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key331 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key332; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key332 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key333; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key333 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key334; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key334 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key335; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key335 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key336; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key336 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key337; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key337 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key338; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key338 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key339; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key339 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key34; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key34 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key340; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key340 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key341; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key341 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key342; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key342 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key343; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key343 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key344; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key344 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key345; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key345 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key346; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key346 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key347; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key347 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key348; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key348 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key349; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key349 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key35; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key35 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key350; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key350 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key351; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key351 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key352; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key352 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key353; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key353 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key354; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key354 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key355; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key355 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key356; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key356 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key357; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key357 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key358; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key358 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key359; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key359 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key36; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key36 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key360; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key360 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key361; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key361 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key362; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key362 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key363; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key363 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key364; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key364 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key365; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key365 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key366; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key366 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key367; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key367 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key368; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key368 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key369; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key369 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key37; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key37 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key370; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key370 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key371; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key371 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key372; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key372 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key373; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key373 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key374; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key374 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key375; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key375 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key376; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key376 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key377; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key377 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key378; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key378 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key379; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key379 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key38; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key38 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key380; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key380 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key381; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key381 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key382; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key382 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key383; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key383 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key39; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key39 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key4; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key4 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key40; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key40 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key41; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key41 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key42; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key42 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key43; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key43 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key44; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key44 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key45; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key45 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key46; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key46 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key47; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key47 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key48; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key48 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key49; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key49 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key5; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key5 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key50; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key50 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key51; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key51 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key52; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key52 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key53; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key53 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key54; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key54 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key55; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key55 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key56; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key56 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key57; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key57 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key58; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key58 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key59; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key59 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key6 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key60; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key60 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key61; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key61 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key62; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key62 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key63; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key63 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key64; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key64 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key65; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key65 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key66; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key66 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key67; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key67 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key68; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key68 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key69; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key69 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key7 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key70; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key70 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key71; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key71 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key72; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key72 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key73; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key73 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key74; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key74 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key75; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key75 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key76; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key76 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key77; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key77 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key78; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key78 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key79; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key79 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key8 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key80; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key80 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key81; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key81 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key82; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key82 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key83; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key83 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key84; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key84 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key85; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key85 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key86; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key86 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key87; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key87 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key88; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key88 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key89; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key89 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key9 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key90; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key90 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key91; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key91 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key92; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key92 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key93; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key93 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key94; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key94 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key95; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key95 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key96; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key96 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key97; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key97 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key98; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key98 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_item_key_key99; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_item_key_key99 UNIQUE (item_key);


--
-- Name: item_dedicated_facility_locations item_dedicated_facility_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dedicated_facility_locations
    ADD CONSTRAINT item_dedicated_facility_locations_pkey PRIMARY KEY (id);


--
-- Name: item_groups item_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_groups
    ADD CONSTRAINT item_groups_pkey PRIMARY KEY (id);


--
-- Name: item_list_tiers item_list_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_list_tiers
    ADD CONSTRAINT item_list_tiers_pkey PRIMARY KEY (id);


--
-- Name: item_list_vendor_rates item_list_vendor_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_list_vendor_rates
    ADD CONSTRAINT item_list_vendor_rates_pkey PRIMARY KEY (id);


--
-- Name: items_list items_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items_list
    ADD CONSTRAINT items_list_pkey PRIMARY KEY (id);


--
-- Name: items_master items_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items_master
    ADD CONSTRAINT items_master_pkey PRIMARY KEY (id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (item_id);


--
-- Name: logistics_schedules logistics_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logistics_schedules
    ADD CONSTRAINT logistics_schedules_pkey PRIMARY KEY (id);


--
-- Name: master_approval_status_history master_approval_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_approval_status_history
    ADD CONSTRAINT master_approval_status_history_pkey PRIMARY KEY (id);


--
-- Name: material_request_notes material_request_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_request_notes
    ADD CONSTRAINT material_request_notes_pkey PRIMARY KEY (id);


--
-- Name: module_definitions module_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_definitions
    ADD CONSTRAINT module_definitions_pkey PRIMARY KEY (id);


--
-- Name: newdevelopments newdevelopments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newdevelopments
    ADD CONSTRAINT newdevelopments_pkey PRIMARY KEY (product_id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (order_item_id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (order_id);


--
-- Name: orders orders_so_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_so_no_key UNIQUE (so_no);


--
-- Name: orders orders_so_no_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_so_no_key1 UNIQUE (so_no);


--
-- Name: pack_materials pack_materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pack_materials
    ADD CONSTRAINT pack_materials_pkey PRIMARY KEY (id);


--
-- Name: packaging packaging_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packaging
    ADD CONSTRAINT packaging_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (permission_id);


--
-- Name: planning_batches planning_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_batches
    ADD CONSTRAINT planning_batches_pkey PRIMARY KEY (id);


--
-- Name: planning_bom_override planning_bom_override_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_bom_override
    ADD CONSTRAINT planning_bom_override_pkey PRIMARY KEY (id);


--
-- Name: planning_bom_override planning_bom_override_planning_extracted_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_bom_override
    ADD CONSTRAINT planning_bom_override_planning_extracted_id_key UNIQUE (planning_extracted_id);


--
-- Name: planning_extracted planning_extracted_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_extracted
    ADD CONSTRAINT planning_extracted_pkey PRIMARY KEY (id);


--
-- Name: planning_quotation_asks planning_quotation_asks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_quotation_asks
    ADD CONSTRAINT planning_quotation_asks_pkey PRIMARY KEY (id);


--
-- Name: po_tracking po_tracking_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_tracking
    ADD CONSTRAINT po_tracking_pkey PRIMARY KEY (id);


--
-- Name: po_tracking po_tracking_purchase_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_tracking
    ADD CONSTRAINT po_tracking_purchase_order_id_key UNIQUE (purchase_order_id);


--
-- Name: procurement_quotations procurement_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_quotations
    ADD CONSTRAINT procurement_quotations_pkey PRIMARY KEY (id);


--
-- Name: procurement_requests procurement_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_requests
    ADD CONSTRAINT procurement_requests_pkey PRIMARY KEY (id);


--
-- Name: product_customizations product_customizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_customizations
    ADD CONSTRAINT product_customizations_pkey PRIMARY KEY (customization_id);


--
-- Name: production_batches production_batches_bmr_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_batches
    ADD CONSTRAINT production_batches_bmr_no_key UNIQUE (bmr_no);


--
-- Name: production_batches production_batches_bmr_no_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_batches
    ADD CONSTRAINT production_batches_bmr_no_key1 UNIQUE (bmr_no);


--
-- Name: production_batches production_batches_bpr_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_batches
    ADD CONSTRAINT production_batches_bpr_no_key UNIQUE (bpr_no);


--
-- Name: production_batches production_batches_bpr_no_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_batches
    ADD CONSTRAINT production_batches_bpr_no_key1 UNIQUE (bpr_no);


--
-- Name: production_batches production_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_batches
    ADD CONSTRAINT production_batches_pkey PRIMARY KEY (id);


--
-- Name: production_equipment production_equipment_equipment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_equipment
    ADD CONSTRAINT production_equipment_equipment_id_key UNIQUE (equipment_id);


--
-- Name: production_equipment production_equipment_equipment_id_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_equipment
    ADD CONSTRAINT production_equipment_equipment_id_key1 UNIQUE (equipment_id);


--
-- Name: production_equipment production_equipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_equipment
    ADD CONSTRAINT production_equipment_pkey PRIMARY KEY (id);


--
-- Name: production_team_members production_team_members_member_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_team_members
    ADD CONSTRAINT production_team_members_member_id_key UNIQUE (member_id);


--
-- Name: production_team_members production_team_members_member_id_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_team_members
    ADD CONSTRAINT production_team_members_member_id_key1 UNIQUE (member_id);


--
-- Name: production_team_members production_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_team_members
    ADD CONSTRAINT production_team_members_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (product_id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: quote_actuals quote_actuals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_actuals
    ADD CONSTRAINT quote_actuals_pkey PRIMARY KEY (id);


--
-- Name: quote_audit_log quote_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_audit_log
    ADD CONSTRAINT quote_audit_log_pkey PRIMARY KEY (id);


--
-- Name: quote_category_rates quote_category_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_category_rates
    ADD CONSTRAINT quote_category_rates_pkey PRIMARY KEY (id);


--
-- Name: quote_conversion_rates quote_conversion_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_conversion_rates
    ADD CONSTRAINT quote_conversion_rates_pkey PRIMARY KEY (id);


--
-- Name: quote_dispatch_config quote_dispatch_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_dispatch_config
    ADD CONSTRAINT quote_dispatch_config_pkey PRIMARY KEY (id);


--
-- Name: quote_emails quote_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_emails
    ADD CONSTRAINT quote_emails_pkey PRIMARY KEY (id);


--
-- Name: quote_grades quote_grades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_grades
    ADD CONSTRAINT quote_grades_pkey PRIMARY KEY (id);


--
-- Name: quote_manufacturing_rules quote_manufacturing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_manufacturing_rules
    ADD CONSTRAINT quote_manufacturing_rules_pkey PRIMARY KEY (id);


--
-- Name: quote_overheads quote_overheads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_overheads
    ADD CONSTRAINT quote_overheads_pkey PRIMARY KEY (id);


--
-- Name: quote_procurement_rules quote_procurement_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_procurement_rules
    ADD CONSTRAINT quote_procurement_rules_pkey PRIMARY KEY (id);


--
-- Name: quote_qc_rules quote_qc_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_qc_rules
    ADD CONSTRAINT quote_qc_rules_pkey PRIMARY KEY (id);


--
-- Name: raw_materials raw_materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_materials
    ADD CONSTRAINT raw_materials_pkey PRIMARY KEY (id);


--
-- Name: refreshTokens refreshTokens_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."refreshTokens"
    ADD CONSTRAINT "refreshTokens_email_key" UNIQUE (email);


--
-- Name: refreshTokens refreshTokens_email_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."refreshTokens"
    ADD CONSTRAINT "refreshTokens_email_key1" UNIQUE (email);


--
-- Name: refreshTokens refreshTokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."refreshTokens"
    ADD CONSTRAINT "refreshTokens_pkey" PRIMARY KEY (id);


--
-- Name: reserved_batch_items reserved_batch_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserved_batch_items
    ADD CONSTRAINT reserved_batch_items_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (role_id);


--
-- Name: roles roles_role_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_role_code_key UNIQUE (role_code);


--
-- Name: roles roles_role_code_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_role_code_key1 UNIQUE (role_code);


--
-- Name: sales_orders sales_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_pkey PRIMARY KEY (id);


--
-- Name: saved_quotes saved_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_quotes
    ADD CONSTRAINT saved_quotes_pkey PRIMARY KEY (id);


--
-- Name: shipment_batches shipment_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_batches
    ADD CONSTRAINT shipment_batches_pkey PRIMARY KEY (id);


--
-- Name: staff_profiles staff_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_profiles
    ADD CONSTRAINT staff_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: transporters transporters_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transporters
    ADD CONSTRAINT transporters_code_key UNIQUE (code);


--
-- Name: transporters transporters_code_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transporters
    ADD CONSTRAINT transporters_code_key1 UNIQUE (code);


--
-- Name: transporters transporters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transporters
    ADD CONSTRAINT transporters_pkey PRIMARY KEY (id);


--
-- Name: universal_swap_history universal_swap_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.universal_swap_history
    ADD CONSTRAINT universal_swap_history_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_email_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key1 UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (userid);


--
-- Name: vendor_clients vendor_clients_entity_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_clients
    ADD CONSTRAINT vendor_clients_entity_code_key UNIQUE (entity_code);


--
-- Name: vendor_clients vendor_clients_entity_code_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_clients
    ADD CONSTRAINT vendor_clients_entity_code_key1 UNIQUE (entity_code);


--
-- Name: vendor_clients vendor_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_clients
    ADD CONSTRAINT vendor_clients_pkey PRIMARY KEY (id);


--
-- Name: vendor_clients vendor_clients_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_clients
    ADD CONSTRAINT vendor_clients_user_id_key UNIQUE (user_id);


--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (contact_id);


--
-- Name: warehouse_inventory_location_history warehouse_inventory_location_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory_location_history
    ADD CONSTRAINT warehouse_inventory_location_history_pkey PRIMARY KEY (id);


--
-- Name: warehouse_inventory warehouse_inventory_pack_material_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory
    ADD CONSTRAINT warehouse_inventory_pack_material_id_key UNIQUE (pack_material_id);


--
-- Name: warehouse_inventory warehouse_inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory
    ADD CONSTRAINT warehouse_inventory_pkey PRIMARY KEY (id);


--
-- Name: warehouse_inventory warehouse_inventory_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory
    ADD CONSTRAINT warehouse_inventory_product_id_key UNIQUE (product_id);


--
-- Name: warehouse_inventory warehouse_inventory_raw_material_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory
    ADD CONSTRAINT warehouse_inventory_raw_material_id_key UNIQUE (raw_material_id);


--
-- Name: warehouse_locations warehouse_locations_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_locations
    ADD CONSTRAINT warehouse_locations_code_key UNIQUE (code);


--
-- Name: warehouse_locations warehouse_locations_code_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_locations
    ADD CONSTRAINT warehouse_locations_code_key1 UNIQUE (code);


--
-- Name: warehouse_locations warehouse_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_locations
    ADD CONSTRAINT warehouse_locations_pkey PRIMARY KEY (id);


--
-- Name: warehouse_locations warehouse_locations_zoho_warehouse_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_locations
    ADD CONSTRAINT warehouse_locations_zoho_warehouse_id_key UNIQUE (zoho_warehouse_id);


--
-- Name: warehouse_locations warehouse_locations_zoho_warehouse_id_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_locations
    ADD CONSTRAINT warehouse_locations_zoho_warehouse_id_key1 UNIQUE (zoho_warehouse_id);


--
-- Name: warehouse_rack_items warehouse_rack_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_rack_items
    ADD CONSTRAINT warehouse_rack_items_pkey PRIMARY KEY (id);


--
-- Name: warehouse_racks warehouse_racks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_racks
    ADD CONSTRAINT warehouse_racks_pkey PRIMARY KEY (id);


--
-- Name: planning_batches_planning_extracted_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planning_batches_planning_extracted_id ON public.planning_batches USING btree (planning_extracted_id);


--
-- Name: planning_batches_planning_extracted_id_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX planning_batches_planning_extracted_id_sequence ON public.planning_batches USING btree (planning_extracted_id, sequence);


--
-- Name: qcat_category_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qcat_category_uniq ON public.quote_category_rates USING btree (category);


--
-- Name: qcr_pkg_band_vol_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qcr_pkg_band_vol_uniq ON public.quote_conversion_rates USING btree (packaging_type, moq_band, volume_key);


--
-- Name: quote_dispatch_grade_ref_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quote_dispatch_grade_ref_uniq ON public.quote_dispatch_config USING btree (grade_ref);


--
-- Name: quote_grades_grade_ref_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quote_grades_grade_ref_uniq ON public.quote_grades USING btree (grade_ref);


--
-- Name: quote_mfg_type_subtype_band_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quote_mfg_type_subtype_band_uniq ON public.quote_manufacturing_rules USING btree (product_type, product_subtype, band_index);


--
-- Name: quote_overhead_cat_head_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quote_overhead_cat_head_uniq ON public.quote_overheads USING btree (product_category, head_name);


--
-- Name: quote_proc_type_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quote_proc_type_key_uniq ON public.quote_procurement_rules USING btree (material_type, category_or_material);


--
-- Name: quote_qc_grade_ref_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quote_qc_grade_ref_uniq ON public.quote_qc_rules USING btree (grade_ref);


--
-- Name: saved_quotes_quote_ref_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX saved_quotes_quote_ref_uniq ON public.saved_quotes USING btree (quote_ref);


--
-- Name: addresses addresses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: appointments appointments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: bd_client_profiles bd_client_profiles_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_client_profiles
    ADD CONSTRAINT bd_client_profiles_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: bd_events bd_events_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_events
    ADD CONSTRAINT bd_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: bd_grievances bd_grievances_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_grievances
    ADD CONSTRAINT bd_grievances_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: bd_meetings bd_meetings_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_meetings
    ADD CONSTRAINT bd_meetings_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: bd_queries bd_queries_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_queries
    ADD CONSTRAINT bd_queries_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: client_appointments client_appointments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_appointments
    ADD CONSTRAINT client_appointments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: client_developments client_developments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_developments
    ADD CONSTRAINT client_developments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: client_orders client_orders_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_orders
    ADD CONSTRAINT client_orders_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: client_queries client_queries_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_queries
    ADD CONSTRAINT client_queries_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: doctor_profiles doctor_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_profiles
    ADD CONSTRAINT doctor_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: enquiries enquiries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: fulfillment_batch_splits fulfillment_batch_splits_fulfillment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_splits
    ADD CONSTRAINT fulfillment_batch_splits_fulfillment_order_id_fkey FOREIGN KEY (fulfillment_order_id) REFERENCES public.fulfillment_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: fulfillment_batch_splits fulfillment_batch_splits_fulfillment_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_splits
    ADD CONSTRAINT fulfillment_batch_splits_fulfillment_order_item_id_fkey FOREIGN KEY (fulfillment_order_item_id) REFERENCES public.fulfillment_order_items(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: fulfillment_batch_splits fulfillment_batch_splits_production_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_splits
    ADD CONSTRAINT fulfillment_batch_splits_production_batch_id_fkey FOREIGN KEY (production_batch_id) REFERENCES public.production_batches(id) ON DELETE SET NULL;


--
-- Name: fulfillment_batch_stage_logs fulfillment_batch_stage_logs_fulfillment_batch_split_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_stage_logs
    ADD CONSTRAINT fulfillment_batch_stage_logs_fulfillment_batch_split_id_fkey FOREIGN KEY (fulfillment_batch_split_id) REFERENCES public.fulfillment_batch_splits(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: fulfillment_batch_stage_logs fulfillment_batch_stage_logs_fulfillment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_batch_stage_logs
    ADD CONSTRAINT fulfillment_batch_stage_logs_fulfillment_order_id_fkey FOREIGN KEY (fulfillment_order_id) REFERENCES public.fulfillment_orders(id) ON DELETE CASCADE;


--
-- Name: fulfillment_invoices fulfillment_invoices_fulfillment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_invoices
    ADD CONSTRAINT fulfillment_invoices_fulfillment_order_id_fkey FOREIGN KEY (fulfillment_order_id) REFERENCES public.fulfillment_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: fulfillment_invoices fulfillment_invoices_transporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_invoices
    ADD CONSTRAINT fulfillment_invoices_transporter_id_fkey FOREIGN KEY (transporter_id) REFERENCES public.transporters(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: fulfillment_order_items fulfillment_order_items_fulfillment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_order_items
    ADD CONSTRAINT fulfillment_order_items_fulfillment_order_id_fkey FOREIGN KEY (fulfillment_order_id) REFERENCES public.fulfillment_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: fulfillment_orders fulfillment_orders_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_orders
    ADD CONSTRAINT fulfillment_orders_sales_order_id_fkey FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE SET NULL;


--
-- Name: goods_received_notes goods_received_notes_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes
    ADD CONSTRAINT goods_received_notes_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id);


--
-- Name: goods_received_notes goods_received_notes_shipment_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes
    ADD CONSTRAINT goods_received_notes_shipment_batch_id_fkey FOREIGN KEY (shipment_batch_id) REFERENCES public.shipment_batches(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: item_list_tiers item_list_tiers_item_list_vendor_rate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_list_tiers
    ADD CONSTRAINT item_list_tiers_item_list_vendor_rate_id_fkey FOREIGN KEY (item_list_vendor_rate_id) REFERENCES public.item_list_vendor_rates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: item_list_vendor_rates item_list_vendor_rates_items_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_list_vendor_rates
    ADD CONSTRAINT item_list_vendor_rates_items_list_id_fkey FOREIGN KEY (items_list_id) REFERENCES public.items_list(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: newdevelopments newdevelopments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newdevelopments
    ADD CONSTRAINT newdevelopments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(order_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(product_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: orders orders_billing_address_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_billing_address_id_fkey FOREIGN KEY (billing_address_id) REFERENCES public.addresses(address_id) ON UPDATE CASCADE;


--
-- Name: orders orders_shipping_address_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_shipping_address_id_fkey FOREIGN KEY (shipping_address_id) REFERENCES public.addresses(address_id) ON UPDATE CASCADE;


--
-- Name: orders orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE;


--
-- Name: payments payments_UserUserid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "payments_UserUserid_fkey" FOREIGN KEY ("UserUserid") REFERENCES public.users(userid) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: payments payments_orderOrderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "payments_orderOrderId_fkey" FOREIGN KEY ("orderOrderId") REFERENCES public.orders(order_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: planning_batches planning_batches_planning_extracted_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_batches
    ADD CONSTRAINT planning_batches_planning_extracted_id_fkey FOREIGN KEY (planning_extracted_id) REFERENCES public.planning_extracted(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: planning_bom_override planning_bom_override_planning_extracted_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_bom_override
    ADD CONSTRAINT planning_bom_override_planning_extracted_id_fkey FOREIGN KEY (planning_extracted_id) REFERENCES public.planning_extracted(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: planning_extracted planning_extracted_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_extracted
    ADD CONSTRAINT planning_extracted_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(product_id) ON UPDATE CASCADE;


--
-- Name: planning_extracted planning_extracted_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_extracted
    ADD CONSTRAINT planning_extracted_sales_order_id_fkey FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON UPDATE CASCADE;


--
-- Name: planning_quotation_asks planning_quotation_asks_planning_extracted_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_quotation_asks
    ADD CONSTRAINT planning_quotation_asks_planning_extracted_id_fkey FOREIGN KEY (planning_extracted_id) REFERENCES public.planning_extracted(id) ON UPDATE CASCADE;


--
-- Name: po_tracking po_tracking_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.po_tracking
    ADD CONSTRAINT po_tracking_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: procurement_quotations procurement_quotations_procurement_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_quotations
    ADD CONSTRAINT procurement_quotations_procurement_request_id_fkey FOREIGN KEY (procurement_request_id) REFERENCES public.procurement_requests(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: procurement_quotations procurement_quotations_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_quotations
    ADD CONSTRAINT procurement_quotations_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendor_clients(id) ON UPDATE CASCADE;


--
-- Name: procurement_requests procurement_requests_planning_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_requests
    ADD CONSTRAINT procurement_requests_planning_batch_id_fkey FOREIGN KEY (planning_batch_id) REFERENCES public.planning_batches(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: procurement_requests procurement_requests_planning_extracted_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_requests
    ADD CONSTRAINT procurement_requests_planning_extracted_id_fkey FOREIGN KEY (planning_extracted_id) REFERENCES public.planning_extracted(id) ON UPDATE CASCADE;


--
-- Name: product_customizations product_customizations_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_customizations
    ADD CONSTRAINT product_customizations_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(product_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: product_customizations product_customizations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_customizations
    ADD CONSTRAINT product_customizations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE;


--
-- Name: production_batches production_batches_planning_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_batches
    ADD CONSTRAINT production_batches_planning_batch_id_fkey FOREIGN KEY (planning_batch_id) REFERENCES public.planning_batches(id) ON DELETE SET NULL;


--
-- Name: production_team_members production_team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_team_members
    ADD CONSTRAINT production_team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON DELETE SET NULL;


--
-- Name: reserved_batch_items reserved_batch_items_fulfillment_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserved_batch_items
    ADD CONSTRAINT reserved_batch_items_fulfillment_order_item_id_fkey FOREIGN KEY (fulfillment_order_item_id) REFERENCES public.fulfillment_order_items(id) ON DELETE CASCADE;


--
-- Name: reserved_batch_items reserved_batch_items_pack_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserved_batch_items
    ADD CONSTRAINT reserved_batch_items_pack_material_id_fkey FOREIGN KEY (pack_material_id) REFERENCES public.pack_materials(id) ON DELETE CASCADE;


--
-- Name: reserved_batch_items reserved_batch_items_planning_extracted_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserved_batch_items
    ADD CONSTRAINT reserved_batch_items_planning_extracted_id_fkey FOREIGN KEY (planning_extracted_id) REFERENCES public.planning_extracted(id) ON DELETE CASCADE;


--
-- Name: reserved_batch_items reserved_batch_items_production_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserved_batch_items
    ADD CONSTRAINT reserved_batch_items_production_batch_id_fkey FOREIGN KEY (production_batch_id) REFERENCES public.production_batches(id) ON DELETE CASCADE;


--
-- Name: reserved_batch_items reserved_batch_items_raw_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reserved_batch_items
    ADD CONSTRAINT reserved_batch_items_raw_material_id_fkey FOREIGN KEY (raw_material_id) REFERENCES public.raw_materials(id) ON DELETE CASCADE;


--
-- Name: staff_profiles staff_profiles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_profiles
    ADD CONSTRAINT staff_profiles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(role_id) ON UPDATE CASCADE;


--
-- Name: staff_profiles staff_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_profiles
    ADD CONSTRAINT staff_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE;


--
-- Name: vendor_clients vendor_clients_account_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_clients
    ADD CONSTRAINT vendor_clients_account_manager_id_fkey FOREIGN KEY (account_manager_id) REFERENCES public.users(userid) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: vendor_clients vendor_clients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_clients
    ADD CONSTRAINT vendor_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(userid) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: warehouse_inventory_location_history warehouse_inventory_location_histor_warehouse_inventory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory_location_history
    ADD CONSTRAINT warehouse_inventory_location_histor_warehouse_inventory_id_fkey FOREIGN KEY (warehouse_inventory_id) REFERENCES public.warehouse_inventory(id);


--
-- Name: warehouse_inventory warehouse_inventory_pack_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory
    ADD CONSTRAINT warehouse_inventory_pack_material_id_fkey FOREIGN KEY (pack_material_id) REFERENCES public.pack_materials(id);


--
-- Name: warehouse_inventory warehouse_inventory_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory
    ADD CONSTRAINT warehouse_inventory_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(product_id);


--
-- Name: warehouse_inventory warehouse_inventory_raw_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_inventory
    ADD CONSTRAINT warehouse_inventory_raw_material_id_fkey FOREIGN KEY (raw_material_id) REFERENCES public.raw_materials(id);


--
-- Name: warehouse_locations warehouse_locations_area_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_locations
    ADD CONSTRAINT warehouse_locations_area_id_fkey FOREIGN KEY (area_id) REFERENCES public.facility_areas(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: warehouse_rack_items warehouse_rack_items_rack_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_rack_items
    ADD CONSTRAINT warehouse_rack_items_rack_id_fkey FOREIGN KEY (rack_id) REFERENCES public.warehouse_racks(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: warehouse_rack_items warehouse_rack_items_warehouse_inventory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_rack_items
    ADD CONSTRAINT warehouse_rack_items_warehouse_inventory_id_fkey FOREIGN KEY (warehouse_inventory_id) REFERENCES public.warehouse_inventory(id) ON DELETE CASCADE;


--
-- Name: warehouse_racks warehouse_racks_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_racks
    ADD CONSTRAINT warehouse_racks_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.warehouse_locations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict mBJ89pH7jDeqzW3XzVq1qJYaqSOFyROtIBJ6L6L9J5LcgoTWpIKsx2OaneFZdMO

