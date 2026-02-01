namespace marine.chatbot;

entity Conversation {
  key cID             : String(64);
  userID              : String(255);
  creation_time       : Timestamp;
  last_update_time    : Timestamp;
  title               : String(255);
}

entity Message {
  key mID             : String(64);
  cID_cID             : String(64);
  role                : String(32);
  content             : LargeString;
  creation_time       : Timestamp;
}
