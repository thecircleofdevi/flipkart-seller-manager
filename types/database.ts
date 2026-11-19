export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      api_requests: {
        Row: {
          duration_ms: number | null
          endpoint: string
          error_message: string | null
          finished_at: string | null
          id: string
          integration_id: string | null
          method: string
          request_meta: Json
          response_meta: Json
          started_at: string
          status_code: number | null
          user_id: string
        }
        Insert: {
          duration_ms?: number | null
          endpoint: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          integration_id?: string | null
          method: string
          request_meta?: Json
          response_meta?: Json
          started_at?: string
          status_code?: number | null
          user_id: string
        }
        Update: {
          duration_ms?: number | null
          endpoint?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          integration_id?: string | null
          method?: string
          request_meta?: Json
          response_meta?: Json
          started_at?: string
          status_code?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_requests_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          access_token: string | null
          access_token_expires_at: string | null
          app_id: string | null
          app_secret: string | null
          created_at: string
          id: string
          last_error: string | null
          name: string
          provider: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          access_token_expires_at?: string | null
          app_id?: string | null
          app_secret?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          name?: string
          provider?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          access_token_expires_at?: string | null
          app_id?: string | null
          app_secret?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          name?: string
          provider?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      listing_inventory: {
        Row: {
          effective_at: string
          id: string
          listing_id: string
          location_id: string
          pending_quantity: number | null
          quantity: number
          raw: Json
          user_id: string
        }
        Insert: {
          effective_at?: string
          id?: string
          listing_id: string
          location_id: string
          pending_quantity?: number | null
          quantity?: number
          raw?: Json
          user_id: string
        }
        Update: {
          effective_at?: string
          id?: string
          listing_id?: string
          location_id?: string
          pending_quantity?: number | null
          quantity?: number
          raw?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listing_inventory_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_inventory_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_locations: {
        Row: {
          created_at: string
          id: string
          listing_id: string
          location_id: string
          status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          listing_id: string
          location_id: string
          status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          listing_id?: string
          location_id?: string
          status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listing_locations_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_prices: {
        Row: {
          currency: string | null
          dealer_price: number | null
          effective_at: string
          effective_selling_price: number | null
          id: string
          listing_id: string
          local_shipping_fee: number | null
          location_id: string | null
          mop: number | null
          mrp: number | null
          national_shipping_fee: number | null
          nlc: number | null
          raw: Json
          selling_price: number | null
          user_id: string
          zonal_shipping_fee: number | null
        }
        Insert: {
          currency?: string | null
          dealer_price?: number | null
          effective_at?: string
          effective_selling_price?: number | null
          id?: string
          listing_id: string
          local_shipping_fee?: number | null
          location_id?: string | null
          mop?: number | null
          mrp?: number | null
          national_shipping_fee?: number | null
          nlc?: number | null
          raw?: Json
          selling_price?: number | null
          user_id: string
          zonal_shipping_fee?: number | null
        }
        Update: {
          currency?: string | null
          dealer_price?: number | null
          effective_at?: string
          effective_selling_price?: number | null
          id?: string
          listing_id?: string
          local_shipping_fee?: number | null
          location_id?: string | null
          mop?: number | null
          mrp?: number | null
          national_shipping_fee?: number | null
          nlc?: number | null
          raw?: Json
          selling_price?: number | null
          user_id?: string
          zonal_shipping_fee?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "listing_prices_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_prices_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      listings: {
        Row: {
          archived_status: string | null
          created_at: string
          dispatch_sla: number | null
          effective_selling_price: number | null
          flipkart_listing_id: string | null
          flipkart_product_id: string | null
          fsn: string | null
          fulfillment_profile: string | null
          hsn: string | null
          id: string
          image_url: string | null
          listing_data: Json
          procurement_type: string | null
          product_id: string | null
          product_url: string | null
          raw: Json
          shipping_provider: string | null
          sku: string
          status: string | null
          updated_at: string
          user_id: string
          vertical: string | null
        }
        Insert: {
          archived_status?: string | null
          created_at?: string
          dispatch_sla?: number | null
          effective_selling_price?: number | null
          flipkart_listing_id?: string | null
          flipkart_product_id?: string | null
          fsn?: string | null
          fulfillment_profile?: string | null
          hsn?: string | null
          id?: string
          image_url?: string | null
          listing_data?: Json
          procurement_type?: string | null
          product_id?: string | null
          product_url?: string | null
          raw?: Json
          shipping_provider?: string | null
          sku: string
          status?: string | null
          updated_at?: string
          user_id: string
          vertical?: string | null
        }
        Update: {
          archived_status?: string | null
          created_at?: string
          dispatch_sla?: number | null
          effective_selling_price?: number | null
          flipkart_listing_id?: string | null
          flipkart_product_id?: string | null
          fsn?: string | null
          fulfillment_profile?: string | null
          hsn?: string | null
          id?: string
          image_url?: string | null
          listing_data?: Json
          procurement_type?: string | null
          product_id?: string | null
          product_url?: string | null
          raw?: Json
          shipping_provider?: string | null
          sku?: string
          status?: string | null
          updated_at?: string
          user_id?: string
          vertical?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "listings_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          address: Json
          created_at: string
          flipkart_location_id: string
          id: string
          integration_id: string | null
          name: string | null
          raw: Json
          status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address?: Json
          created_at?: string
          flipkart_location_id: string
          id?: string
          integration_id?: string | null
          name?: string | null
          raw?: Json
          status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: Json
          created_at?: string
          flipkart_location_id?: string
          id?: string
          integration_id?: string | null
          name?: string | null
          raw?: Json
          status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          event_key: string | null
          event_timestamp: string | null
          event_type: string
          id: string
          location_id: string | null
          payload: Json
          processing_error: string | null
          processing_status: string
          received_at: string
          shipment_id: string | null
          user_id: string
        }
        Insert: {
          event_key?: string | null
          event_timestamp?: string | null
          event_type: string
          id?: string
          location_id?: string | null
          payload?: Json
          processing_error?: string | null
          processing_status?: string
          received_at?: string
          shipment_id?: string | null
          user_id: string
        }
        Update: {
          event_key?: string | null
          event_timestamp?: string | null
          event_type?: string
          id?: string
          location_id?: string | null
          payload?: Json
          processing_error?: string | null
          processing_status?: string
          received_at?: string
          shipment_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      order_items: {
        Row: {
          cancellation_group_id: string | null
          created_at: string
          customer_price: number | null
          flipkart_order_item_id: string
          fsn: string | null
          id: string
          is_replacement: boolean | null
          listing_id: string | null
          order_id: string
          quantity: number | null
          raw: Json
          selling_price: number | null
          shipping_charge: number | null
          sku: string | null
          status: string | null
          total_price: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cancellation_group_id?: string | null
          created_at?: string
          customer_price?: number | null
          flipkart_order_item_id: string
          fsn?: string | null
          id?: string
          is_replacement?: boolean | null
          listing_id?: string | null
          order_id: string
          quantity?: number | null
          raw?: Json
          selling_price?: number | null
          shipping_charge?: number | null
          sku?: string | null
          status?: string | null
          total_price?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cancellation_group_id?: string | null
          created_at?: string
          customer_price?: number | null
          flipkart_order_item_id?: string
          fsn?: string | null
          id?: string
          is_replacement?: boolean | null
          listing_id?: string | null
          order_id?: string
          quantity?: number | null
          raw?: Json
          selling_price?: number | null
          shipping_charge?: number | null
          sku?: string | null
          status?: string | null
          total_price?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          flipkart_order_id: string
          id: string
          order_date: string | null
          raw: Json
          status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          flipkart_order_id: string
          id?: string
          order_date?: string | null
          raw?: Json
          status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          flipkart_order_id?: string
          id?: string
          order_date?: string | null
          raw?: Json
          status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          attributes: Json
          brand: string | null
          category: string | null
          created_at: string
          flipkart_product_id: string | null
          fsn: string | null
          id: string
          image_url: string | null
          product_url: string | null
          raw: Json
          title: string | null
          updated_at: string
          user_id: string
          vertical: string | null
        }
        Insert: {
          attributes?: Json
          brand?: string | null
          category?: string | null
          created_at?: string
          flipkart_product_id?: string | null
          fsn?: string | null
          id?: string
          image_url?: string | null
          product_url?: string | null
          raw?: Json
          title?: string | null
          updated_at?: string
          user_id: string
          vertical?: string | null
        }
        Update: {
          attributes?: Json
          brand?: string | null
          category?: string | null
          created_at?: string
          flipkart_product_id?: string | null
          fsn?: string | null
          id?: string
          image_url?: string | null
          product_url?: string | null
          raw?: Json
          title?: string | null
          updated_at?: string
          user_id?: string
          vertical?: string | null
        }
        Relationships: []
      }
      raw_flipkart_payloads: {
        Row: {
          captured_at: string
          external_id: string | null
          id: string
          payload: Json
          payload_hash: string | null
          source_type: string
          sync_run_id: string | null
          user_id: string
        }
        Insert: {
          captured_at?: string
          external_id?: string | null
          id?: string
          payload: Json
          payload_hash?: string | null
          source_type: string
          sync_run_id?: string | null
          user_id: string
        }
        Update: {
          captured_at?: string
          external_id?: string | null
          id?: string
          payload?: Json
          payload_hash?: string | null
          source_type?: string
          sync_run_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_flipkart_payloads_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      return_events: {
        Row: {
          created_at: string
          event_timestamp: string | null
          event_type: string
          id: string
          payload: Json
          return_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_timestamp?: string | null
          event_type: string
          id?: string
          payload?: Json
          return_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_timestamp?: string | null
          event_type?: string
          id?: string
          payload?: Json
          return_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "return_events_return_id_fkey"
            columns: ["return_id"]
            isOneToOne: false
            referencedRelation: "returns"
            referencedColumns: ["id"]
          },
        ]
      }
      returns: {
        Row: {
          created_at: string
          flipkart_return_id: string
          id: string
          location_id: string | null
          order_item_id: string | null
          raw: Json
          return_reason: string | null
          shipment_id: string | null
          source: string | null
          status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          flipkart_return_id: string
          id?: string
          location_id?: string | null
          order_item_id?: string | null
          raw?: Json
          return_reason?: string | null
          shipment_id?: string | null
          source?: string | null
          status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          flipkart_return_id?: string
          id?: string
          location_id?: string | null
          order_item_id?: string | null
          raw?: Json
          return_reason?: string | null
          shipment_id?: string | null
          source?: string | null
          status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "returns_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_events: {
        Row: {
          created_at: string
          event_timestamp: string | null
          event_type: string
          flipkart_event_id: string | null
          id: string
          payload: Json
          shipment_id: string | null
          source: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_timestamp?: string | null
          event_type: string
          flipkart_event_id?: string | null
          id?: string
          payload?: Json
          shipment_id?: string | null
          source?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_timestamp?: string | null
          event_type?: string
          flipkart_event_id?: string | null
          id?: string
          payload?: Json
          shipment_id?: string | null
          source?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_events_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_items: {
        Row: {
          id: string
          order_item_id: string | null
          quantity: number | null
          raw: Json
          shipment_id: string
          user_id: string
        }
        Insert: {
          id?: string
          order_item_id?: string | null
          quantity?: number | null
          raw?: Json
          shipment_id: string
          user_id: string
        }
        Update: {
          id?: string
          order_item_id?: string | null
          quantity?: number | null
          raw?: Json
          shipment_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_items_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments: {
        Row: {
          address_data: Json
          buyer_data: Json
          courier_name: string | null
          created_at: string
          dispatch_after: string | null
          dispatch_by: string | null
          flipkart_shipment_id: string
          forms_data: Json
          hold: boolean | null
          id: string
          invoice_data: Json
          location_id: string | null
          mps: boolean | null
          order_id: string | null
          packages_data: Json
          raw: Json
          service_profile: string | null
          shipment_type: string | null
          state: string | null
          tracking_id: string | null
          tracking_url: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address_data?: Json
          buyer_data?: Json
          courier_name?: string | null
          created_at?: string
          dispatch_after?: string | null
          dispatch_by?: string | null
          flipkart_shipment_id: string
          forms_data?: Json
          hold?: boolean | null
          id?: string
          invoice_data?: Json
          location_id?: string | null
          mps?: boolean | null
          order_id?: string | null
          packages_data?: Json
          raw?: Json
          service_profile?: string | null
          shipment_type?: string | null
          state?: string | null
          tracking_id?: string | null
          tracking_url?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address_data?: Json
          buyer_data?: Json
          courier_name?: string | null
          created_at?: string
          dispatch_after?: string | null
          dispatch_by?: string | null
          flipkart_shipment_id?: string
          forms_data?: Json
          hold?: boolean | null
          id?: string
          invoice_data?: Json
          location_id?: string | null
          mps?: boolean | null
          order_id?: string | null
          packages_data?: Json
          raw?: Json
          service_profile?: string | null
          shipment_type?: string | null
          state?: string | null
          tracking_id?: string | null
          tracking_url?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipments_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_checkpoints: {
        Row: {
          cursor: Json
          domain: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cursor?: Json
          domain: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cursor?: Json
          domain?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_runs: {
        Row: {
          error_message: string | null
          finished_at: string | null
          id: string
          metadata: Json
          records_seen: number
          records_written: number
          run_key: string | null
          started_at: string
          status: string
          sync_type: string
          user_id: string
        }
        Insert: {
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json
          records_seen?: number
          records_written?: number
          run_key?: string | null
          started_at?: string
          status: string
          sync_type: string
          user_id: string
        }
        Update: {
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json
          records_seen?: number
          records_written?: number
          run_key?: string | null
          started_at?: string
          status?: string
          sync_type?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
