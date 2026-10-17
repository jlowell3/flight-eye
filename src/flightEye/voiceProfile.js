/**
 * Flight Eye's voice profile: the name the build sends on the token request
 * and the tools that profile offers. Pure data shared by the browser (which
 * filters its own catalog) and the server (server/providers/openai/
 * profiles.js, which mints the session with these tools only).
 *
 * Names must match the action schemas (src/voice/actionSchemas.js) and the
 * catalog tools on the voice surface (src/tools/surfaces.js). The server
 * refuses to mint a session for a profile naming a tool it does not have.
 */

export const FLIGHT_EYE_VOICE_PROFILE = 'flight-eye';

export const FLIGHT_EYE_VOICE_TOOLS = Object.freeze([
  // Camera
  'fly_to_location',
  'move_camera',
  'adjust_camera_zoom',
  'frame_overhead',
  'zoom_to_globe',
  // Aircraft and cockpit
  'select_nearest_aircraft',
  'track_entity',
  'stop_tracking',
  'control_cockpit',
  'set_context_mode',
  'get_entity_context',
  'get_current_view_state',
  'analyst_query',
  'get_aircraft_info',
  'get_aircraft_track',
  'military_awareness',
  // Console
  'set_layer_visibility',
  'show_data_layers_menu',
  'set_panel_open',
  'set_visual_style',
  'set_post_processing',
  'set_detection',
  'set_hud',
  'set_map_stack',
  // Situation
  'get_metar',
  'get_nearby_airports',
  'get_weather',
  'get_wind',
  'get_regional_brief',
  'search_places',
  'places_nearby',
  'get_terrain_height',
]);
